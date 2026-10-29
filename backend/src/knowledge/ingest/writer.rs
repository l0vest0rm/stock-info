//! Native local knowledge import writer. Sync-ledger I/O belongs to the ingest coordinator.
use crate::{AppState, db::sql_value};
use anyhow::{Result, bail};
use regex::Regex;
use rusqlite::{Transaction, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;

fn text(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.trim().into(),
        _ => v.to_string().trim().into(),
    }
}
fn field(v: &Value, names: &[&str]) -> Value {
    names
        .iter()
        .find_map(|n| v.get(*n).filter(|v| !v.is_null()))
        .cloned()
        .unwrap_or(Value::Null)
}
fn s(v: &Value, names: &[&str]) -> String {
    text(&field(v, names))
}
fn integer(v: &Value, fallback: i64) -> i64 {
    if v.is_null() {
        return 0;
    }
    v.as_i64()
        .or_else(|| {
            v.as_str()
                .and_then(|s| s.parse::<f64>().ok())
                .or_else(|| v.as_f64())
                .filter(|n| n.is_finite() && n.fract() == 0.0)
                .map(|n| n as i64)
        })
        .unwrap_or(fallback)
}
fn intfield(v: &Value, names: &[&str], fallback: i64) -> i64 {
    let f = field(v, names);
    if f.is_null() {
        fallback
    } else {
        integer(&f, fallback)
    }
}
fn object(v: &Value) -> Value {
    if v.is_object() {
        v.clone()
    } else {
        v.as_str()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .filter(Value::is_object)
            .unwrap_or(json!({}))
    }
}
fn array(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}
fn nullable(s: String) -> Value {
    if s.is_empty() { Value::Null } else { s.into() }
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn stable(v: &Value, metadata: bool) -> Value {
    match v {
        Value::Array(a) => Value::Array(a.iter().map(|v| stable(v, metadata)).collect()),
        Value::Object(o) => {
            let dated = !s(v, &["eventTime", "event_time"]).is_empty()
                || !s(v, &["publishedAt", "published_at"]).is_empty();
            Value::Object(
                o.iter()
                    .filter(|(k, _)| {
                        !matches!(
                            k.as_str(),
                            "file" | "sourceFile" | "source_file" | "updatedAt" | "updated_at"
                        ) && !(dated && matches!(k.as_str(), "fetchedAt" | "fetched_at"))
                            && !(metadata
                                && matches!(
                                    k.as_str(),
                                    "inputFile"
                                        | "inputRelativeFile"
                                        | "originalFile"
                                        | "processedAt"
                                        | "sourceMtimeMs"
                                        | "sourceSize"
                                ))
                    })
                    .map(|(k, v)| {
                        (
                            k.clone(),
                            stable(v, matches!(k.as_str(), "metadata" | "metadata_json")),
                        )
                    })
                    .collect(),
            )
        }
        _ => v.clone(),
    }
}
// JSON.stringify enumerates array-index object keys numerically, even when the
// source stable-field walker inserted them in lexical order.
fn fingerprint_json(v: &Value) -> String {
    match v {
        Value::Object(o) => {
            let index = |k: &str| {
                k.parse::<u32>()
                    .ok()
                    .filter(|n| *n < u32::MAX && n.to_string() == k)
            };
            let mut keys = o.keys().collect::<Vec<_>>();
            keys.sort_by(|a, b| match (index(a), index(b)) {
                (Some(a), Some(b)) => a.cmp(&b),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                _ => a.encode_utf16().cmp(b.encode_utf16()),
            });
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|k| format!(
                        "{}:{}",
                        serde_json::to_string(k).unwrap(),
                        fingerprint_json(&o[k])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Value::Array(a) => format!(
            "[{}]",
            a.iter().map(fingerprint_json).collect::<Vec<_>>().join(",")
        ),
        _ => crate::knowledge::information_records::canonical_json(v),
    }
}
pub fn import_fingerprint(v: &Value) -> String {
    format!(
        "sha256:v1:{}",
        hash(fingerprint_json(&stable(v, false)).as_bytes())
    )
}
fn code(raw: &str) -> String {
    let v = raw.trim().to_uppercase();
    for (pattern, replacement) in [
        (r"^(SH|SZ|BJ)(\d{6})$", "$2.$1"),
        (r"^HK(\d{5})$", "$1.HK"),
        (r"^US([A-Z0-9.-]+)\.(OQ|NQ|N|AMEX|PK|OB)$", "$1.US"),
    ] {
        let r = Regex::new(pattern).unwrap();
        if r.is_match(&v) {
            return r.replace(&v, replacement).into_owned();
        }
    }
    if Regex::new(r"^(\d{6}\.(SH|SZ|BJ)|\d{5}\.HK|[A-Z0-9.-]+\.US)$")
        .unwrap()
        .is_match(&v)
    {
        v
    } else {
        String::new()
    }
}
fn aliases(name: &str) -> Vec<String> {
    let base = Regex::new(r"(?i)\.(SH|SZ|US|HK|BJ|PT)$")
        .unwrap()
        .replace(name.trim(), "")
        .into_owned();
    let base = Regex::new(r"(?i)-(SW|W|B|S|R)$")
        .unwrap()
        .replace(&base, "")
        .trim()
        .to_owned();
    let short =
        Regex::new(r"(股份有限公司|集团有限公司|控股有限公司|科技有限公司|股份|集团|控股|科技)$")
            .unwrap()
            .replace(&base, "")
            .trim()
            .to_owned();
    [name.trim().to_owned(), base, short]
        .into_iter()
        .filter(|v| !v.is_empty())
        .collect()
}
fn preview(markdown: &str) -> String {
    let mut p = markdown.to_string();
    for (pat, repl) in [
        (
            r"(?i)\*\*==>\s*picture\s*\[[^\]]+\]\s*intentionally omitted\s*<==\*\*",
            "",
        ),
        (r"(?s)```.*?```", ""),
        (r"`([^`]+)`", "$1"),
        (r"!\[[^\]]*\]\([^)]*\)", ""),
        (r"\[([^\]]+)\]\([^)]*\)", "$1"),
        (r"(?m)^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)", ""),
        (r"\s+", " "),
    ] {
        p = Regex::new(pat).unwrap().replace_all(&p, repl).into_owned();
    }
    let p = p.trim();
    if p.chars().count() > 280 {
        format!("{}...", p.chars().take(280).collect::<String>())
    } else {
        p.into()
    }
}
async fn body(state: &AppState, id: &str, markdown: &str) -> Result<Value> {
    let mut result = json!({"contentKey":"","contentUrl":"","contentType":"text/markdown; charset=utf-8","contentEncoding":"identity","contentBytes":0,"contentSha256":"","contentPreview":""});
    let markdown = markdown.trim();
    if markdown.is_empty() {
        return Ok(result);
    }
    let sha = hash(markdown.as_bytes());
    let mut payload = markdown.as_bytes().to_vec();
    let mut encoding = "identity";
    let min = state
        .setting("KNOWLEDGE_CONTENT_COMPRESS_MIN_BYTES")
        .parse::<usize>()
        .ok()
        .filter(|v| *v > 0)
        .unwrap_or(4096);
    if payload.len() >= min {
        let mut compressed = Vec::new();
        {
            let mut w = brotli::CompressorWriter::new(&mut compressed, 4096, 5, 22);
            w.write_all(&payload)?;
        }
        if compressed.len() < payload.len() {
            payload = compressed;
            encoding = "br";
        }
    }
    let idhash = hash(id.as_bytes());
    let ext = if encoding == "br" { "md.br" } else { "md" };
    let key = format!(
        "knowledge-content/{}/{}-{}.{}",
        &idhash[..2],
        idhash,
        &sha[..12],
        ext
    );
    let bytes = payload.len();
    state
        .knowledge_store()?
        .put(crate::knowledge::object_key(&key), payload)
        .await?;
    result["contentKey"] = key.clone().into();
    result["contentUrl"] = crate::knowledge::local_content_url(state, &key).into();
    result["contentEncoding"] = encoding.into();
    result["contentBytes"] = bytes.into();
    result["contentSha256"] = sha.into();
    result["contentPreview"] = preview(markdown).into();
    Ok(result)
}
struct Item {
    row: BTreeMap<String, Value>,
    content: Value,
    links: Vec<String>,
    tags: Vec<String>,
    stock_aliases: Vec<(String, String, String, String)>,
    entry: Value,
}
fn upsert(
    tx: &Transaction<'_>,
    table: &str,
    row: &BTreeMap<String, Value>,
    preserve: &[&str],
) -> Result<()> {
    let names = row.keys().map(String::as_str).collect::<Vec<_>>();
    let updates = names
        .iter()
        .filter(|n| **n != "doc_id" && !preserve.contains(n))
        .map(|n| format!("{n}=excluded.{n}"))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "INSERT INTO {table}({}) VALUES({}) ON CONFLICT(doc_id) DO UPDATE SET {updates}",
        names.join(","),
        vec!["?"; names.len()].join(",")
    );
    tx.execute(
        &sql,
        rusqlite::params_from_iter(row.values().map(sql_value)),
    )?;
    Ok(())
}

pub async fn import_documents(state: &AppState, docs: &[Value], config: &Value) -> Result<Value> {
    import(state, docs, config, false).await
}
pub async fn import_filtered(state: &AppState, docs: &[Value], config: &Value) -> Result<Value> {
    import(state, docs, config, true).await
}
async fn import(state: &AppState, docs: &[Value], config: &Value, filtered: bool) -> Result<Value> {
    if config["remote"].as_bool() == Some(true) {
        bail!("remote knowledge imports are retired; local SQLite only")
    }
    let scope = if filtered {
        "knowledge_filtered_docs"
    } else {
        "knowledge_docs"
    };
    if filtered && state.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_filtered_docs'", vec![]).await?.is_empty() {
        bail!("filteredReviewImport SQL storage was retired by migration 0115; keep rejected review JSONL artifacts instead (no database table may be recreated)")
    }

    let database = s(config, &["database"]);
    let database = if database.is_empty() {
        "stock_info".into()
    } else {
        database
    };
    let mut alias_map: BTreeMap<String, Option<String>> = BTreeMap::new();
    for row in state.db.query("SELECT code,short_name AS alias FROM stock UNION ALL SELECT code,code AS alias FROM stock UNION ALL SELECT code,alias FROM stock_alias",vec![]).await? {let c=code(&s(&row,&["code"]));if c.is_empty(){continue}for a in aliases(&s(&row,&["alias"])) {let a=a.to_lowercase();alias_map.entry(a).and_modify(|old|{if old.as_deref()!=Some(c.as_str()){*old=None}}).or_insert(Some(c.clone()));}}
    let resolve = |c: &str, n: &str| {
        let c = code(c);
        if !c.is_empty() {
            c
        } else {
            aliases(n)
                .iter()
                .find_map(|a| alias_map.get(&a.to_lowercase()).and_then(Clone::clone))
                .unwrap_or_default()
        }
    };
    let synced = array(&config["syncEntries"])
        .into_iter()
        .filter(|e| {
            s(e, &["scope"]) == scope
                && s(e, &["database"]) == database
                && s(e, &["target"]) == "local"
        })
        .map(|e| (s(&e, &["docId"]), e))
        .collect::<BTreeMap<_, _>>();
    let mut items = Vec::new();
    let mut entries = Vec::new();
    let mut skipped = 0;
    for raw in docs {
        let doc = if filtered {
            raw.get("doc").unwrap_or(raw)
        } else {
            raw
        };
        let metadata = object(&field(doc, &["metadata", "metadata_json"]));
        let id = s(doc, &["docId", "doc_id", "id"]);
        let title = s(doc, &["title"]);
        if id.is_empty() || title.is_empty() {
            bail!("knowledge import requires nonempty docId and title")
        }
        if !filtered
            && matches!(
                s(&metadata, &["source"]).as_str(),
                "tencent_stock_news" | "cls_telegraph"
            )
        {
            bail!("information-feed sources must not enter knowledge_docs")
        }
        let fingerprint = import_fingerprint(raw);
        let mut source_file = s(raw, &["file", "sourceFile", "source_file"]);
        if !filtered || source_file.is_empty() {
            source_file = s(&metadata, &["inputRelativeFile"])
        }
        if let Some(old) = synced
            .get(&id)
            .filter(|e| e["hasD1"].as_bool() == Some(true))
        {
            let previous = s(old, &["importFingerprint"]);
            let matched = if previous.is_empty() {
                s(old, &["sourceFile"]) == source_file
                    && intfield(old, &["sourceMtimeMs"], -1)
                        == intfield(&metadata, &["sourceMtimeMs"], -2)
                    && intfield(old, &["sourceSize"], -1)
                        == intfield(&metadata, &["sourceSize"], -2)
            } else {
                previous == fingerprint
            };
            if matched {
                skipped += 1;
                if previous.is_empty() {
                    let mut upgraded = old.clone();
                    upgraded["importFingerprint"] = fingerprint.into();
                    upgraded["importedAt"] = chrono::Utc::now()
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                        .into();
                    entries.push(upgraded);
                }
                continue;
            }
        }
        let now = chrono::Utc::now().timestamp_millis();
        let updated = intfield(raw, &["updatedAt", "updated_at"], now);
        let content = body(
            state,
            &id,
            &s(
                doc,
                if filtered {
                    &["markdown", "mdText", "md_text"]
                } else {
                    &["mdText", "md_text", "markdown"]
                },
            ),
        )
        .await?;
        let source = s(doc, &["sourceType", "source_type"]);
        let source = if source.is_empty() {
            "research_report".into()
        } else {
            source
        };
        let report = s(doc, &["reportType", "report_type"]);
        let report = if report.is_empty() {
            source.clone()
        } else {
            report
        };
        let target_name = s(doc, &["targetName", "target_name"]);
        let target_raw = s(doc, &["targetCode", "target_code"]);
        let target = if filtered {
            target_raw
        } else {
            resolve(&target_raw, &target_name)
        };
        let mut row = BTreeMap::new();
        row.insert("doc_id".into(), id.clone().into());
        row.insert("source_type".into(), source.into());
        row.insert("report_type".into(), nullable(report));
        for (column, names) in [
            ("source_name", vec!["sourceName", "source_name"]),
            ("title", vec!["title"]),
            ("url", vec!["url"]),
            ("published_at", vec!["publishedAt", "published_at"]),
            ("fetched_at", vec!["fetchedAt", "fetched_at"]),
            (
                "event_time",
                vec!["eventTime", "event_time", "publishedAt", "published_at"],
            ),
            ("summary", vec!["summary"]),
        ] {
            row.insert(column.into(), nullable(s(doc, &names)));
        }
        row.insert("target_name".into(), nullable(target_name.clone()));
        row.insert("target_code".into(), nullable(target.clone()));
        let mut access = s(doc, &["accessMethod", "access_method"]);
        if !s(&content, &["contentKey"]).is_empty() && (!filtered || access.is_empty()) {
            access = "markdown".into()
        } else if access.is_empty() {
            access = if filtered {
                if s(doc, &["url"]).to_lowercase().contains(".pdf") {
                    "remote_pdf"
                } else {
                    ""
                }
            } else {
                "markdown"
            }
            .into()
        }
        row.insert("access_method".into(), nullable(access));
        row.insert(
            "content_preview".into(),
            nullable(s(&content, &["contentPreview"])),
        );
        row.insert(
            "metadata_json".into(),
            serde_json::to_string(&metadata)?.into(),
        );
        row.insert("updated_at".into(), updated.into());
        let mut tags = Vec::new();
        let mut links = Vec::new();
        let mut stock_aliases = Vec::new();
        if filtered {
            let filter = raw
                .get("filter")
                .or_else(|| raw.get("topic"))
                .unwrap_or(raw);
            let filter_value = |key: &str| {
                filter
                    .get(key)
                    .filter(|v| !v.is_null())
                    .or_else(|| raw.get(key))
                    .cloned()
                    .unwrap_or(Value::Null)
            };
            row.insert(
                "filter_method".into(),
                nullable(text(&filter_value("method"))),
            );
            row.insert(
                "filter_score".into(),
                integer(&filter_value("score"), 0).into(),
            );
            row.insert(
                "filter_confidence".into(),
                filter_value("confidence")
                    .as_f64()
                    .or_else(|| {
                        filter_value("confidence")
                            .as_str()
                            .and_then(|s| s.parse::<f64>().ok())
                    })
                    .filter(|n| n.is_finite())
                    .map_or(Value::Null, |n| json!(n)),
            );
            row.insert(
                "filter_reasons_json".into(),
                serde_json::to_string(
                    &array(&filter_value("reasons"))
                        .iter()
                        .map(text)
                        .filter(|s| !s.is_empty())
                        .collect::<Vec<_>>(),
                )?
                .into(),
            );
            row.insert("source_file".into(), nullable(source_file.clone()));
            let review = s(raw, &["reviewedStatus", "reviewed_status"]);
            row.insert(
                "reviewed_status".into(),
                if review.is_empty() {
                    "pending".into()
                } else {
                    review.into()
                },
            );
        } else {
            let mut seen_tags = BTreeSet::new();
            let tagset = array(&doc["tags"])
                .iter()
                .map(text)
                .filter(|s| !s.is_empty() && seen_tags.insert(s.clone()))
                .collect::<Vec<_>>();
            tags = tagset
                .iter()
                .map(|s| s.to_lowercase())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            let recommendation = intfield(doc, &["recommendationScore", "recommendation_score"], 0);
            row.insert("recommendation_score".into(), recommendation.into());
            row.insert(
                "rank_score".into(),
                intfield(doc, &["rankScore", "rank_score"], recommendation).into(),
            );
            row.insert(
                "source_weight".into(),
                intfield(doc, &["sourceWeight", "source_weight"], 0).into(),
            );
            row.insert(
                "recommendation_level".into(),
                nullable(s(doc, &["recommendationLevel", "recommendation_level"])),
            );
            row.insert(
                "recommendation_tags_json".into(),
                serde_json::to_string(&tagset)?.into(),
            );
            row.insert(
                "recommendation_reasons_json".into(),
                serde_json::to_string(
                    &array(&field(
                        doc,
                        &["recommendationReasons", "recommendation_reasons"],
                    ))
                    .iter()
                    .map(text)
                    .collect::<Vec<_>>(),
                )?
                .into(),
            );
            let discovery = s(doc, &["discoveryMethod", "discovery_method"]);
            row.insert(
                "discovery_method".into(),
                nullable(if discovery.is_empty() {
                    "local_import".into()
                } else {
                    discovery
                }),
            );
            let sort = ["event_time", "published_at", "fetched_at"]
                .iter()
                .map(|k| text(&row[*k]))
                .find(|s| !s.is_empty())
                .unwrap_or_default();
            row.insert("sort_time".into(), sort.into());
            row.insert(
                "source_name_normalized".into(),
                s(doc, &["sourceName", "source_name"]).to_lowercase().into(),
            );
            row.insert(
                "target_code_normalized".into(),
                target.to_uppercase().into(),
            );
            if !target.is_empty() {
                links.push(target.clone());
                if !target_name.is_empty() {
                    for a in [&target_name, &target] {
                        stock_aliases.push((
                            a.clone(),
                            target.clone(),
                            target_name.clone(),
                            "target".into(),
                        ))
                    }
                }
            }
            for link in array(&metadata["stockLinks"]) {
                let name = s(&link, &["name"]);
                let c = resolve(&s(&link, &["code"]), &name);
                let link_code = code(&s(&link, &["code"]));
                if !link_code.is_empty() {
                    links.push(link_code)
                }
                if c.is_empty() {
                    continue;
                }
                let mut aa = aliases(&name);
                aa.push(c.clone());
                aa.push(c.split('.').next().unwrap_or("").into());
                aa.extend(array(&link["aliases"]).iter().map(text));
                for a in aa.into_iter().filter(|a| !a.is_empty()) {
                    stock_aliases.push((a, c.clone(), name.clone(), "doc_metadata".into()));
                }
            }
        }
        let mut entry = json!({"scope":scope,"docId":id,"database":database,"target":"local","importedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"sourceFile":source_file,"sourceMtimeMs":intfield(&metadata,&["sourceMtimeMs"],0),"sourceSize":intfield(&metadata,&["sourceSize"],0),"contentBucket":state.setting("KNOWLEDGE_CONTENT_BUCKET"),"importFingerprint":fingerprint,"hasD1":true,"hasR2":false});
        if text(&entry["contentBucket"]).is_empty() {
            entry["contentBucket"] = "stock-info-knowledge-content".into()
        }
        for key in [
            "contentKey",
            "contentUrl",
            "contentType",
            "contentEncoding",
            "contentBytes",
            "contentSha256",
        ] {
            entry[key] = content[key].clone();
        }
        items.push(Item {
            row,
            content,
            links,
            tags,
            stock_aliases,
            entry,
        });
    }
    let imported = items.len();
    let mut batches = 0;
    while !items.is_empty() {
        let chunk = items.drain(..items.len().min(1000)).collect::<Vec<_>>();
        let results=state.db.run(move|conn|{
        let tx=conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;let mut committed=Vec::new();
        for item in chunk{let id=&item.row["doc_id"];let updated=&item.row["updated_at"];upsert(&tx,scope,&item.row,if filtered{&["reviewed_status"]}else{&[]})?;let reftable=if filtered{"knowledge_filtered_doc_content_refs"}else{"knowledge_doc_content_refs"};if s(&item.content,&["contentKey"]).is_empty(){tx.execute(&format!("DELETE FROM {reftable} WHERE doc_id=?"),[sql_value(id)])?;}else{let mut r=BTreeMap::new();r.insert("doc_id".into(),id.clone());r.insert("updated_at".into(),updated.clone());for (col,key) in [("content_key","contentKey"),("content_url","contentUrl"),("content_type","contentType"),("content_encoding","contentEncoding"),("content_bytes","contentBytes"),("content_sha256","contentSha256")]{r.insert(col.into(),item.content[key].clone());}upsert(&tx,reftable,&r,&[])?;}
            if !filtered {tx.execute("DELETE FROM knowledge_doc_tags WHERE doc_id=?",[sql_value(id)])?;for tag in item.tags{tx.execute("INSERT INTO knowledge_doc_tags(doc_id,tag) VALUES(?,?)",params![text(id),tag])?;}tx.execute("DELETE FROM knowledge_doc_security_links WHERE doc_id=?",[sql_value(id)])?;for c in item.links.into_iter().collect::<BTreeSet<_>>(){tx.execute("INSERT INTO knowledge_doc_security_links(doc_id,code) VALUES(?,?) ON CONFLICT DO NOTHING",params![text(id),c])?;}
                let mut names=BTreeMap::new();for (_,c,n,_) in &item.stock_aliases{if !n.is_empty(){names.entry(c.clone()).or_insert(n.clone());}}for (c,n) in &names{tx.execute("INSERT INTO stock(code,short_name,updated_at) VALUES(?,?,?) ON CONFLICT(code) DO UPDATE SET short_name=excluded.short_name,updated_at=excluded.updated_at WHERE excluded.updated_at>=stock.updated_at",params![c,n,sql_value(updated)])?;}
                for (a,c,_,source) in item.stock_aliases {let a=a.trim().to_lowercase();let cl=c.to_lowercase();if !names.contains_key(&c)||a==cl||a==cl.split('.').next().unwrap_or("")||a==cl.rsplit_once('.').map(|p|p.0).unwrap_or(""){continue}tx.execute("INSERT INTO stock_alias(alias,code,source,updated_at) VALUES(?,?,?,?) ON CONFLICT(alias,code) DO UPDATE SET source=excluded.source,updated_at=excluded.updated_at WHERE excluded.updated_at>=stock_alias.updated_at",params![a,c,source,sql_value(updated)])?;}
            }committed.push(item.entry);
        }tx.commit()?;Ok(committed)
    }).await?;
        entries.extend(results);
        batches += 1;
    }
    Ok(
        json!({"imported":imported,"skipped":skipped,"skippedSynced":skipped,"entries":entries,"batches":batches,"localExecutor":"sqlite-transaction"}),
    )
}
