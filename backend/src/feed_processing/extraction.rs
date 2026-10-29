//! Native feed extraction producer. Network work never occurs inside a SQLite transaction.
use crate::{AppState, knowledge::information_records::*};
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::{collections::HashMap, path::Path};

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn chars(v: &str) -> usize {
    v.encode_utf16().count()
}
fn re(pattern: &str, value: &str) -> bool {
    regex::Regex::new(pattern).unwrap().is_match(value)
}
fn member(v: &Value, text: &str) -> bool {
    v.as_array().is_some_and(|a| a.iter().any(|x| x == text))
}
fn date_range(period: &str, body: &str) -> bool {
    if !body.contains(period) {
        return false;
    }
    let iso = regex::Regex::new(r"^(\d{4})-(\d{2})-(\d{2})\s*[-–—至]\s*(\d{4})-(\d{2})-(\d{2})$")
        .unwrap();
    let chinese=regex::Regex::new(r"^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日\s*[-–—至]\s*(?:(\d{4})年)?(?:(\d{1,2})月)?(\d{1,2})日$").unwrap();
    let Some(c) = iso.captures(period).or_else(|| chinese.captures(period)) else {
        return false;
    };
    if c.get(4).is_some() && c.get(1).is_none() {
        return false;
    }
    let n = |i, default| {
        c.get(i)
            .and_then(|v| v.as_str().parse::<u32>().ok())
            .unwrap_or(default)
    };
    if n(1, 2000) == 0 || n(4, n(1, 2000)) == 0 {
        return false;
    }
    let a = chrono::NaiveDate::from_ymd_opt(n(1, 2000) as i32, n(2, 0), n(3, 0));
    let b = chrono::NaiveDate::from_ymd_opt(n(4, n(1, 2000)) as i32, n(5, n(2, 0)), n(6, 0));
    a.zip(b).is_some_and(|(a, b)| a <= b)
}
fn valid_period(value: &str, body: &str) -> bool {
    if chars(value) > 32 {
        return false;
    }
    if date_range(value, body) {
        return true;
    }
    if body.contains(value) {
        let months = regex::Regex::new(
            r"^(?:(\d{4})年)?(\d{1,2})月(?:份)?(?:[-–—至](?:(\d{4})年)?(\d{1,2})月(?:份)?)?$",
        )
        .unwrap();
        if let Some(c) = months.captures(value) {
            let n = |i, d| {
                c.get(i)
                    .and_then(|v| v.as_str().parse::<u32>().ok())
                    .unwrap_or(d)
            };
            let y = n(1, 2000);
            let m = n(2, 0);
            let ey = n(3, y);
            let em = n(4, m);
            return y > 0
                && ey > 0
                && !(c.get(3).is_some() && c.get(1).is_none())
                && (1..=12).contains(&m)
                && (1..=12).contains(&em)
                && y * 12 + m <= ey * 12 + em;
        }
        if re(
            r"^(?:[1-9]\d{3}年(?:前后|底|初|末)?|上半年|下半年|全年|第[一二三四1-4]季度|[一二三四五六七八九十两]{1,3}(?:至[一二三四五六七八九十两]{1,3})?(?:天|个?交易日|周|个月|月|季度|年)(?:内|期间|以来)?)$",
            value,
        ) || re(
            r"^(?:(?:近|最近|过去|未来)(?:几|数)(?:天|周|个月|月|季度|年)|\d{1,2}(?:[-—–至]\d{1,2})?(?:天|周|个月|月|季度|年)(?:内|期间|以来)?|本周|上周|下周|今年|明年|去年|本财年|下一财年|上个月|本月|下个月|本季度|上季度|下季度)$",
            value,
        ) {
            return true;
        }
    }
    re(
        r"^(?:\d{4}(?:Q[1-4]|H[12]|FY)|\d{4}-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?|\d{4}年(?:[1-9]|1[0-2])月|截至\d{4}-\d{2}-\d{2}|(?:近|最近|过去|未来)\d{1,2}(?:天|周|个月|月|季度|年)|\d{4}年(?:第?[一二三四1-4]季度|上半年|下半年|全年|前\d{1,2}个月))$",
        value,
    )
}
fn measurement(v: &Value, period: &Value) -> Value {
    let keys = [
        "fiscalYear",
        "rawValue",
        "rawUnit",
        "currency",
        "accountingBasis",
        "ownershipBasis",
        "shareBasis",
    ];
    if !v
        .as_object()
        .is_some_and(|o| o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k)))
    {
        return Value::Null;
    }
    let year = v["fiscalYear"]
        .as_f64()
        .filter(|v| v.is_finite() && v.fract() == 0.0)
        .map(|v| v as i64);
    if year.is_none()
        || v["rawValue"].as_f64().is_none_or(|n| !n.is_finite())
        || ![
            "currency",
            "ten_thousand_currency",
            "million_currency",
            "hundred_million_currency",
            "billion_currency",
            "percent",
            "currency_per_share",
        ]
        .contains(&s(&v["rawUnit"]))
        || !["gaap", "non_gaap", "adjusted", "unspecified"].contains(&s(&v["accountingBasis"]))
        || ![
            "attributable_to_parent",
            "consolidated",
            "common_shareholders",
            "unspecified",
        ]
        .contains(&s(&v["ownershipBasis"]))
        || !["basic", "diluted", "unspecified"].contains(&s(&v["shareBasis"]))
        || (!v["currency"].is_null() && !re(r"^[A-Z]{3}$", s(&v["currency"])))
        || !re(&format!(r"^{}(?:FY|Q[1-4])$", year.unwrap_or(0)), s(period))
    {
        return Value::Null;
    }
    v.clone()
}
/// Validate model output again at the storage boundary; source evidence is mandatory.
pub fn parse_extraction(text: &str, body: &str, ontology: &Value) -> Result<Value> {
    let mut text = text.trim();
    if text.starts_with("```") {
        text = text.trim_start_matches("```");
        if text.to_ascii_lowercase().starts_with("json") {
            text = &text[4..];
        }
        text = text.trim().strip_suffix("```").unwrap_or(text).trim();
    }
    let response: Value = serde_json::from_str(text)?;
    ensure!(
        response.as_object().is_some_and(|v| v.len() == 2
            && v.contains_key("records")
            && v.contains_key("categoryCandidates")),
        "invalid feed extraction response"
    );
    let records = response["records"]
        .as_array()
        .context("records must be array")?;
    let candidates = response["categoryCandidates"]
        .as_array()
        .context("categoryCandidates must be array")?;
    ensure!(
        records.len() + candidates.len() <= 3,
        "too many extracted records"
    );
    let categories = &ontology["informationExtraction"]["categories"];
    let types = &ontology["informationExtraction"]["informationTypes"];
    let mut parsed = Vec::new();
    for record in records {
        ensure!(
            record.as_object().is_some_and(|o| o.keys().all(|k| [
                "entity",
                "informationType",
                "category",
                "period",
                "statement",
                "forecastMeasurement"
            ]
            .contains(&k.as_str()))),
            "invalid feed record"
        );
        let entity = s(&record["entity"]).trim();
        let statement = s(&record["statement"]).trim();
        let category = s(&record["category"]);
        let information_type = s(&record["informationType"]);
        let rule = &categories[category];
        ensure!(
            !entity.is_empty()
                && chars(entity) <= 120
                && !statement.is_empty()
                && chars(statement) <= 120
                && statement.contains(entity),
            "invalid entity/statement"
        );
        ensure!(
            member(types, information_type) && member(&rule["informationTypes"], information_type),
            "unsupported category/informationType"
        );
        let period = if record["period"].is_null() || record["period"] == "" {
            Value::Null
        } else {
            record["period"].clone()
        };
        ensure!(
            period.is_null() || (period.is_string() && valid_period(s(&period), body)),
            "invalid period"
        );
        ensure!(
            rule["periodPolicy"] != "required" || !period.is_null(),
            "period required"
        );
        ensure!(
            rule["periodPolicy"] != "forbidden" || period.is_null(),
            "period forbidden"
        );
        let forecast = if information_type == "forecast"
            && [
                "revenue",
                "revenue_growth",
                "net_profit",
                "net_profit_growth",
                "gross_margin",
                "eps",
                "operating_cash_flow",
            ]
            .contains(&category)
        {
            measurement(&record["forecastMeasurement"], &period)
        } else {
            Value::Null
        };
        parsed.push(json!({"entity":entity,"informationType":information_type,"category":category,"period":period,"statement":statement,"forecastMeasurement":forecast}));
    }
    let mut cc = Vec::new();
    for candidate in candidates {
        let keys = [
            "entity",
            "informationType",
            "statement",
            "suggestedCategory",
            "evidence",
            "whyNotExisting",
        ];
        ensure!(
            candidate
                .as_object()
                .is_some_and(|o| o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k))),
            "invalid category candidate"
        );
        let mut c = json!({});
        for key in keys {
            c[key] = json!(s(&candidate[key]).trim());
        }
        let entity = s(&c["entity"]);
        let statement = s(&c["statement"]);
        let suggested = s(&c["suggestedCategory"]);
        let evidence = s(&c["evidence"]);
        ensure!(
            !entity.is_empty()
                && chars(entity) <= 120
                && member(types, s(&c["informationType"]))
                && !statement.is_empty()
                && chars(statement) <= 120
                && statement.contains(entity),
            "invalid candidate entity/statement"
        );
        ensure!(
            (2..=40).contains(&chars(suggested))
                && !["其他", "综合信息", "一般事件"].contains(&suggested)
                && categories.get(suggested).is_none()
                && !categories
                    .as_object()
                    .context("invalid ontology")?
                    .values()
                    .any(|r| r["label"] == suggested),
            "invalid suggested category"
        );
        ensure!(
            (10..=160).contains(&chars(evidence))
                && body.contains(evidence)
                && !s(&c["whyNotExisting"]).is_empty()
                && chars(s(&c["whyNotExisting"])) <= 160,
            "invalid candidate evidence"
        );
        ensure!(
            !parsed.iter().any(|r| r["statement"] == c["statement"]),
            "candidate duplicates record"
        );
        cc.push(c);
    }
    Ok(json!({"records":parsed,"categoryCandidates":cc}))
}
pub fn fingerprint(row: &Value, body: &str, contract: &Value) -> String {
    sha256_text(
        &serde_json::to_string(&json!([
            body,
            row["title"],
            row["published_at"],
            contract["categoryCatalogHash"],
            contract["promptHash"],
            contract["candidatePolicyHash"],
            contract["contractVersion"],
            contract["model"]
        ]))
        .unwrap(),
    )
}
fn should_attempt(state: &Value, fp: &str, contract: &Value, time: i64) -> bool {
    let attempt = &state["lastAttempt"];
    if state["status"] == "processing" && attempt["leaseUntil"].as_i64().unwrap_or(0) > time {
        return false;
    }
    if state["status"] == "failed"
        && attempt["inputFingerprint"] == fp
        && contract_matches(attempt, contract)
        && (attempt["attempts"].as_u64().unwrap_or(0) >= MAX_EXTRACTION_ATTEMPTS
            || attempt["nextRetryAt"].as_i64().unwrap_or(0) > time)
    {
        return false;
    }
    let current = &state["current"];
    !(state["status"] == "complete"
        && current["storageVersion"] == INFORMATION_STORAGE_VERSION
        && current["provenanceStatus"] == "verified"
        && current["inputFingerprint"] == fp
        && !s(&current["contentSha256"]).is_empty()
        && !s(&current["recordsDigest"]).is_empty()
        && contract_matches(current, contract))
}
fn read_document(conn: &Connection, id: &str) -> Result<Value> {
    let row=conn.query_row("SELECT d.metadata_json,d.title,d.published_at,d.source_type,c.content_sha256 FROM knowledge_docs d LEFT JOIN knowledge_doc_content_refs c ON c.doc_id=d.doc_id WHERE d.doc_id=?",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,String>(3)?,r.get::<_,Option<String>>(4)?)))?;
    Ok(
        json!({"doc_id":id,"meta":serde_json::from_str::<Value>(&row.0)?,"title":row.1,"published_at":row.2,"source_type":row.3,"content_sha256":row.4}),
    )
}
fn same_source(current: &Value, expected: &Value, body: &str) -> bool {
    current["meta"]["feed"].get("fullBodyHash").is_some()
        && current["content_sha256"] == sha256_text(body)
        && current["title"] == expected["title"]
        && current["published_at"] == expected["published_at"]
        && current["source_type"] == expected["source_type"]
        && current["meta"]["feed"]["fullBodyHash"] == expected["meta"]["feed"]["fullBodyHash"]
        && current["meta"]["feed"]["contentType"] == expected["meta"]["feed"]["contentType"]
}
fn write_meta(conn: &Connection, row: &Value, time: i64) -> Result<()> {
    ensure!(
        conn.execute(
            "UPDATE knowledge_docs SET metadata_json=?,updated_at=? WHERE doc_id=?",
            params![
                serde_json::to_string(&row["meta"])?,
                time,
                s(&row["doc_id"])
            ]
        )? == 1,
        "metadata update failed"
    );
    Ok(())
}
async fn claim(
    state: &AppState,
    row: &Value,
    body: &str,
    contract: &Value,
    fp: &str,
    owner: &str,
) -> Result<bool> {
    let (expected, body, contract, fp, owner) = (
        row.clone(),
        body.to_owned(),
        contract.clone(),
        fp.to_owned(),
        owner.to_owned(),
    );
    state
        .db
        .run(move |conn| {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let time = now();
            let mut row = read_document(&tx, s(&expected["doc_id"]))?;
            ensure!(
                same_source(&row, &expected, &body),
                "extraction input changed"
            );
            ensure!(
                row["meta"]["feed"].get("records").is_none()
                    && row["meta"]["feed"].get("taggingStatus").is_none(),
                "legacy feed metadata needs backfill before extraction"
            );
            let old = &row["meta"]["informationExtraction"];
            if !should_attempt(old, &fp, &contract, time) {
                return Ok(false);
            }
            let attempts = if old["lastAttempt"]["inputFingerprint"] == fp
                && contract_matches(&old["lastAttempt"], &contract)
            {
                old["lastAttempt"]["attempts"].as_u64().unwrap_or(0)
            } else {
                0
            };
            let mut attempt = contract;
            attempt["inputFingerprint"] = json!(fp);
            attempt["leaseOwner"] = json!(owner);
            attempt["leaseUntil"] = json!(time + 900_000);
            attempt["attemptedAt"] = json!(time);
            attempt["attempts"] = json!(attempts);
            if !row["meta"]["informationExtraction"].is_object() {
                row["meta"]["informationExtraction"] =
                    json!({"current":null,"categoryCandidates":null});
            }
            row["meta"]["informationExtraction"]["storageVersion"] =
                json!(INFORMATION_STORAGE_VERSION);
            row["meta"]["informationExtraction"]["status"] = json!("processing");
            row["meta"]["informationExtraction"]["lastAttempt"] = attempt;
            write_meta(&tx, &row, time)?;
            tx.commit()?;
            Ok(true)
        })
        .await
}
fn normalize_name(value: &str) -> String {
    let value = value.trim();
    value
        .strip_suffix("股份有限公司")
        .or_else(|| value.strip_suffix("有限公司"))
        .unwrap_or(value)
        .to_lowercase()
}
fn entity_key(record: &Value, candidates: &Value) -> Value {
    let name = normalize_name(s(&record["entity"]));
    let mut matches = Vec::new();
    for c in candidates.as_array().into_iter().flatten() {
        if (normalize_name(s(&c["name"])) == name || normalize_name(s(&c["matchedAlias"])) == name)
            && !matches.contains(&c["tagId"])
        {
            matches.push(c["tagId"].clone());
        }
    }
    if matches.len() == 1 {
        matches[0].clone()
    } else {
        Value::Null
    }
}
pub fn make_rows(
    doc_id: &str,
    fp: &str,
    records: &[Value],
    candidates: &Value,
    time: i64,
) -> Vec<Value> {
    let mut occurrences = HashMap::<String, usize>::new();
    records.iter().enumerate().map(|(order,record)|{
        let key=canonical_json(record);let occurrence=occurrences.entry(key).or_default();let id=format!("i_{}",sha256_text(&canonical_json(&json!([doc_id,fp,record,*occurrence]))));*occurrence+=1;
        let empty=json!({});
        json!({"information_id":id,"doc_id":doc_id,"entity":record["entity"],"entity_key":entity_key(record,candidates),"information_type":record["informationType"],"category":record["category"],"period":record["period"],"statement":record["statement"],"forecast_measurement_json":canonical_json(if record["forecastMeasurement"].is_object(){&record["forecastMeasurement"]}else{&empty}),"sort_order":order,"created_at":time})
    }).collect()
}
async fn commit(
    state: &AppState,
    expected: &Value,
    body: &str,
    contract: &Value,
    fp: &str,
    owner: &str,
    output: (&Value, &Value),
) -> Result<()> {
    let (parsed, candidates) = output;
    let (expected, body, contract, fp, owner, parsed, candidates) = (
        expected.clone(),
        body.to_owned(),
        contract.clone(),
        fp.to_owned(),
        owner.to_owned(),
        parsed.clone(),
        candidates.clone(),
    );
    state.db.run(move|conn|{
        let tx=conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;let time=now();let id=s(&expected["doc_id"]);
        let mut row=read_document(&tx,id)?;
        ensure!(same_source(&row,&expected,&body),"extraction input changed; result not committed");
        let attempt=&row["meta"]["informationExtraction"]["lastAttempt"];
        ensure!(row["meta"]["informationExtraction"]["status"]=="processing"&&attempt["leaseOwner"]==owner&&attempt["leaseUntil"].as_i64().unwrap_or(0)>time&&attempt["inputFingerprint"]==fp&&contract_matches(attempt,&contract)&&fingerprint(&row,&body,&contract)==fp,"extraction lease or fingerprint changed");
        let attempted_at=attempt["attemptedAt"].clone();
        let mut rows=make_rows(id,&fp,parsed["records"].as_array().context("invalid records")?,&candidates,time);
        for record in &mut rows {
            let old=tx.query_row("SELECT entity,information_type,category,period,statement,forecast_measurement_json,created_at FROM knowledge_information_records WHERE information_id=?",[s(&record["information_id"])],|r|Ok(json!({"entity":r.get::<_,String>(0)?,"information_type":r.get::<_,String>(1)?,"category":r.get::<_,String>(2)?,"period":r.get::<_,Option<String>>(3)?,"statement":r.get::<_,String>(4)?,"forecast_measurement_json":r.get::<_,String>(5)?,"created_at":r.get::<_,i64>(6)?})));
            match old {Ok(old)=>{ensure!(canonical_json(&row_to_information(&old)?)==canonical_json(&row_to_information(record)?),"an existing information ID cannot be assigned different content");record["created_at"]=old["created_at"].clone();},Err(rusqlite::Error::QueryReturnedNoRows)=>{},Err(e)=>return Err(e.into())}
        }
        tx.execute("DELETE FROM knowledge_information_records WHERE doc_id=?",[id])?;
        for r in &rows {tx.execute("INSERT INTO knowledge_information_records(information_id,doc_id,entity,entity_key,information_type,category,period,statement,forecast_measurement_json,sort_order,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",params![s(&r["information_id"]),id,s(&r["entity"]),r["entity_key"].as_str(),s(&r["information_type"]),s(&r["category"]),r["period"].as_str(),s(&r["statement"]),s(&r["forecast_measurement_json"]),r["sort_order"].as_i64(),r["created_at"].as_i64()])?;}
        let cc=parsed["categoryCandidates"].as_array().context("invalid candidates")?;
        let mut current=contract.clone();for (k,v) in json!({"storageVersion":INFORMATION_STORAGE_VERSION,"outcome":extraction_outcome(&rows,Some(cc)),"inputFingerprint":fp,"contentSha256":row["content_sha256"],"title":row["title"],"publishedAt":row["published_at"],"completedAt":time,"recordsDigest":sha256_text(&records_digest_input(&rows)?),"recordCount":rows.len(),"categoryCandidateCount":cc.len(),"provenanceStatus":"verified"}).as_object().unwrap(){current[k]=v.clone();}
        let mut attempt=contract.clone();for(k,v)in json!({"inputFingerprint":fp,"attemptedAt":attempted_at,"attempts":0,"nextRetryAt":null,"leaseOwner":null,"leaseUntil":null}).as_object().unwrap(){attempt[k]=v.clone();}
        row["meta"]["informationExtraction"]=json!({"storageVersion":INFORMATION_STORAGE_VERSION,"status":"complete","current":current,"categoryCandidates":cc,"lastAttempt":attempt});
        tx.execute("DELETE FROM knowledge_doc_tags WHERE doc_id=? AND (tag LIKE 'company:%' OR tag LIKE 'category:%' OR tag LIKE 'topic:%' OR tag LIKE 'theme:%' OR tag LIKE 'focus:%')",[id])?;
        for tag in tags_for_information_rows(&rows){tx.execute("INSERT INTO knowledge_doc_tags(doc_id,tag,weight,tagging_input_fingerprint,contract_version) VALUES(?,?,?,?,?)",params![id,s(&tag["tag"]),tag["weight"].as_i64(),fp,s(&contract["contractVersion"])])?;}
        write_meta(&tx,&row,time)?;tx.commit()?;Ok(())
    }).await
}
async fn fail(state: &AppState, id: &str, owner: &str, error: &str) -> Result<()> {
    let (id, owner, error) = (
        id.to_owned(),
        owner.to_owned(),
        error.chars().take(300).collect::<String>(),
    );
    state
        .db
        .run(move |conn| {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let mut row = read_document(&tx, &id)?;
            let ext = &mut row["meta"]["informationExtraction"];
            if ext["status"] != "processing" || ext["lastAttempt"]["leaseOwner"] != owner {
                return Ok(());
            }
            let attempts = ext["lastAttempt"]["attempts"].as_u64().unwrap_or(0) + 1;
            let time = now();
            ext["status"] = json!("failed");
            let a = &mut ext["lastAttempt"];
            a["attempts"] = json!(attempts);
            a["attemptedAt"] = json!(time);
            a["leaseOwner"] = Value::Null;
            a["leaseUntil"] = Value::Null;
            a["nextRetryAt"] =
                json!(time + (60_000_i64 * 2_i64.pow(attempts.min(10) as u32)).min(86_400_000));
            a["error"] = json!(error);
            write_meta(&tx, &row, time)?;
            tx.commit()?;
            Ok(())
        })
        .await
}
// JSON.stringify compatibility without sorting configuration object keys.
fn ordered_json(input: &str) -> Result<String> {
    fn parse(input: &str, offset: &mut usize) -> Result<String> {
        let bytes = input.as_bytes();
        while bytes.get(*offset).is_some_and(u8::is_ascii_whitespace) {
            *offset += 1;
        }
        let start = *offset;
        match bytes
            .get(*offset)
            .copied()
            .context("truncated configuration JSON")?
        {
            b'{' | b'[' => {
                let object = bytes[*offset] == b'{';
                let end = if object { b'}' } else { b']' };
                *offset += 1;
                let mut parts = Vec::new();
                let mut names = std::collections::HashSet::new();
                loop {
                    while bytes.get(*offset).is_some_and(u8::is_ascii_whitespace) {
                        *offset += 1;
                    }
                    if bytes.get(*offset) == Some(&end) {
                        *offset += 1;
                        break;
                    }
                    let first = parse(input, offset)?;
                    if object {
                        let name: String = serde_json::from_str(&first)?;
                        ensure!(names.insert(name), "duplicate configuration key");
                        while bytes.get(*offset).is_some_and(u8::is_ascii_whitespace) {
                            *offset += 1;
                        }
                        ensure!(bytes.get(*offset) == Some(&b':'), "missing JSON colon");
                        *offset += 1;
                        parts.push(format!("{first}:{}", parse(input, offset)?));
                    } else {
                        parts.push(first);
                    }
                    while bytes.get(*offset).is_some_and(u8::is_ascii_whitespace) {
                        *offset += 1;
                    }
                    if bytes.get(*offset) == Some(&end) {
                        *offset += 1;
                        break;
                    }
                    ensure!(bytes.get(*offset) == Some(&b','), "missing JSON comma");
                    *offset += 1;
                }
                Ok(format!(
                    "{}{}{}",
                    if object { "{" } else { "[" },
                    parts.join(","),
                    if object { "}" } else { "]" }
                ))
            }
            b'"' => {
                *offset += 1;
                let mut escaped = false;
                while let Some(&b) = bytes.get(*offset) {
                    *offset += 1;
                    if escaped {
                        escaped = false;
                    } else if b == b'\\' {
                        escaped = true;
                    } else if b == b'"' {
                        return Ok(serde_json::to_string(&serde_json::from_str::<String>(
                            &input[start..*offset],
                        )?)?);
                    }
                }
                anyhow::bail!("unterminated configuration string")
            }
            _ => {
                while bytes
                    .get(*offset)
                    .is_some_and(|b| !b.is_ascii_whitespace() && !b",]}".contains(b))
                {
                    *offset += 1;
                }
                Ok(canonical_json(&serde_json::from_str::<Value>(
                    &input[start..*offset],
                )?))
            }
        }
    }
    parse(input, &mut 0)
}
fn save_usage(path: &Path, usage: &Value) -> Result<()> {
    let parent = path.parent().context("usage has no directory")?;
    std::fs::create_dir_all(parent)?;
    let temp = parent.join(format!(".feed-usage-{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, serde_json::to_vec(usage)?)?;
    std::fs::rename(temp, path)?;
    Ok(())
}
/// Caller holds the cross-process feed lock. Only passing whitelist rows may be tagged.
pub async fn tag_pending(state: &AppState, options: &Value) -> Result<Value> {
    ensure!(
        state.setting("LLM_RUNTIME") == "local",
        "information feed tagging requires LLM_RUNTIME=local"
    );
    let config = state.config("config/knowledge/information-feed.json")?;
    let ontology = state.config("config/knowledge/knowledge-ontology.json")?;
    let contracts = extraction_contracts()?;
    let contract = &contracts[0];
    let system = std::fs::read_to_string(
        state
            .root
            .join("prompts/information-feed/document-analysis-system.md"),
    )?
    .trim()
    .to_owned();
    let template = std::fs::read_to_string(
        state
            .root
            .join("prompts/information-feed/document-analysis-user.md"),
    )?
    .trim()
    .to_owned();
    ensure!(
        sha256_text(&(system.clone() + &template)) == contract["promptHash"],
        "extraction contract build is stale; run npm run build:prompts"
    );
    let ontology_text =
        std::fs::read_to_string(state.root.join("config/knowledge/knowledge-ontology.json"))?;
    let label = regex::Regex::new(r#", "label": "(?:[^"\\]|\\.)*""#)?;
    ensure!(
        sha256_text(&label.replace_all(&ontology_text, "")) == contract["categoryCatalogHash"],
        "category catalog build is stale"
    );
    let config_text =
        std::fs::read_to_string(state.root.join("config/knowledge/information-feed.json"))?;
    let policy_text = config_text
        .split_once("\"companyCandidates\"")
        .context("missing company candidate policy")?
        .1;
    let policy_text = policy_text
        .split_once(':')
        .context("invalid company candidate policy")?
        .1;
    ensure!(
        sha256_text(&ordered_json(policy_text)?) == contract["candidatePolicyHash"],
        "candidate policy contract build is stale"
    );
    ensure!(
        config["tagContract"] == contract["contractVersion"],
        "tag contract mismatch"
    );
    let path = match state.setting("INFORMATION_FEED_TAG_USAGE_FILE") {
        v if !v.is_empty() => state.root.join(v),
        _ => state
            .root
            .join("data/local/information-feed-tag-usage.json"),
    };
    let day = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let mut usage = if path.exists() {
        serde_json::from_slice::<Value>(&std::fs::read(&path)?)?
    } else {
        json!({"day":day,"count":0})
    };
    if usage["day"] != day {
        usage = json!({"day":day,"count":0});
    }
    let remaining = config["automation"]["maxTagsPerDay"]
        .as_u64()
        .unwrap_or(500)
        .saturating_sub(usage["count"].as_u64().unwrap_or(0));
    let limit = remaining.min(options["maxTags"].as_u64().unwrap_or(20));
    if limit == 0 {
        return Ok(json!({"tagged":0,"tagFailed":0,"quotaExhausted":true}));
    }
    let aliases=state.db.query("SELECT s.short_name AS alias,s.code,s.short_name AS name FROM stock s UNION ALL SELECT a.alias,a.code,s.short_name AS name FROM stock_alias a JOIN stock s ON s.code=a.code",vec![]).await?;
    let rows=state.db.query("SELECT d.doc_id,d.source_type,d.title,d.published_at,d.sort_time,d.metadata_json,c.content_key,c.content_sha256 FROM knowledge_docs d JOIN knowledge_doc_content_refs c ON c.doc_id=d.doc_id WHERE d.source_type='information_feed' ORDER BY d.sort_time DESC,d.doc_id DESC",vec![]).await?;
    let periods = HashMap::from([
        ("required", "期间必填"),
        ("optional", "期间可省略"),
        ("forbidden", "不得填写期间"),
    ]);
    // Preserve category source insertion order using the textual ontology traversal.
    let category_start = ontology_text
        .find("\"categories\"")
        .context("missing categories")?;
    let key_re = regex::Regex::new(r#""([^"\\]+)"\s*:\s*\{"#)?;
    let catalog = key_re
        .captures_iter(&ontology_text[category_start..])
        .filter_map(|cap| {
            let key = &cap[1];
            let rule = &ontology["informationExtraction"]["categories"][key];
            rule.is_object().then(|| {
                format!(
                    "{}（{}）: {}；{}{}",
                    key,
                    s(&rule["label"]),
                    rule["informationTypes"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(s)
                        .collect::<Vec<_>>()
                        .join("|"),
                    periods.get(s(&rule["periodPolicy"])).unwrap_or(&""),
                    if s(&rule["description"]).is_empty() {
                        String::new()
                    } else {
                        format!("；{}", s(&rule["description"]))
                    }
                )
            })
        })
        .collect::<Vec<_>>()
        .join("\n");
    let entity_types = ontology["entityTypes"]
        .as_array()
        .context("invalid entity types")?
        .iter()
        .map(s)
        .collect::<Vec<_>>()
        .join("|");
    let mut tagged = 0;
    let mut failed = 0;
    let placeholder = regex::Regex::new(r"\{\{([A-Z_]+)\}\}")?;
    for mut row in rows {
        if tagged + failed >= limit {
            break;
        }
        row["meta"] = serde_json::from_str(s(&row["metadata_json"]))?;
        let ext = &row["meta"]["informationExtraction"];
        if let Some(id) = options["docId"].as_str().filter(|v| !v.is_empty())
            && row["doc_id"] != id
        {
            continue;
        }
        if options["retryFailed"] == true {
            if ext["status"] != "failed" {
                continue;
            }
        } else {
            let date = chrono::DateTime::parse_from_rfc3339(s(&row["sort_time"]))
                .ok()
                .map(|d| d.timestamp_millis());
            if date.is_none_or(|t| {
                t < now() - options["maxAgeHours"].as_i64().unwrap_or(48) * 3_600_000 || t > now()
            }) {
                continue;
            }
        }
        if row["meta"]["feed"]["investmentGate"]["effectiveDisposition"] != "pass" {
            continue;
        }
        let Some(body) = crate::knowledge::read_content_text(state, s(&row["content_key"])).await?
        else {
            continue;
        };
        if sha256_text(&body) != row["content_sha256"] {
            // A corrupt source cannot acquire a lease or spend model quota.
            failed += 1;
            continue;
        }
        if options["docId"].as_str().is_none_or(str::is_empty)
            && contracts.iter().any(|c| {
                contract_matches(&ext["current"], c)
                    && !should_attempt(ext, &fingerprint(&row, &body, c), c, now())
            })
        {
            continue;
        }
        let fp = fingerprint(&row, &body, contract);
        if !should_attempt(ext, &fp, contract, now()) {
            continue;
        }
        let owner = uuid::Uuid::new_v4().to_string();
        match claim(state, &row, &body, contract, &fp, &owner).await {
            Ok(true) => {}
            Ok(false) => continue,
            Err(_) => {
                failed += 1;
                continue;
            }
        }
        usage["count"] = json!(usage["count"].as_u64().unwrap_or(0) + 1);
        if let Err(error) = save_usage(&path, &usage) {
            fail(state, s(&row["doc_id"]), &owner, &error.to_string()).await?;
            failed += 1;
            continue;
        }
        let content = body
            .chars()
            .scan(0, |n, c| {
                *n += c.len_utf16();
                (*n <= 12000).then_some(c)
            })
            .collect::<String>();
        let values = HashMap::from([
            ("CATEGORY_CATALOG", catalog.clone()),
            ("ENTITY_TYPES", entity_types.clone()),
            ("TITLE", s(&row["title"]).to_owned()),
            ("SOURCE_TYPE", s(&row["source_type"]).to_owned()),
            (
                "VALIDATION_ERROR",
                serde_json::to_string(&ext["lastAttempt"]["error"])?,
            ),
            (
                "REPORT_TYPE",
                s(&row["meta"]["feed"]["contentType"]).to_owned(),
            ),
            ("PUBLISHED_AT", s(&row["published_at"]).to_owned()),
            ("CONTENT", content.clone()),
        ]);
        let input = placeholder
            .replace_all(&template, |captures: &regex::Captures<'_>| {
                values.get(&captures[1]).cloned().unwrap_or_default()
            })
            .into_owned();
        let result=async {
            let text=crate::research::taskd::direct_text(state,&json!({"model":contract["model"],"expectedModel":contract["model"],"instructions":system,"input":[{"role":"user","content":[{"type":"input_text","text":input}]}],"maxTokens":2500})).await?;
            let parsed=parse_extraction(&text,&content,&ontology)?;
            let candidates=super::rules::company_candidates(&aliases,s(&row["title"]),&body,&config["companyCandidates"]);
            commit(state,&row,&body,contract,&fp,&owner,(&parsed,&candidates)).await
        }.await;
        match result {
            Ok(()) => tagged += 1,
            Err(error) => {
                fail(state, s(&row["doc_id"]), &owner, &error.to_string()).await?;
                failed += 1;
            }
        }
    }
    Ok(json!({"tagged":tagged,"tagFailed":failed,"quotaExhausted":false}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ontology() -> Value {
        serde_json::from_str(include_str!(
            "../../../config/knowledge/knowledge-ontology.json"
        ))
        .unwrap()
    }
    #[test]
    fn candidate_policy_order_matches_generated_hash() {
        let source = include_str!("../../../config/knowledge/information-feed.json");
        let policy = source
            .split_once("\"companyCandidates\"")
            .unwrap()
            .1
            .split_once(':')
            .unwrap()
            .1;
        assert_eq!(
            sha256_text(&ordered_json(policy).unwrap()),
            extraction_contracts().unwrap()[0]["candidatePolicyHash"]
        );
        assert_eq!(
            ordered_json(r#"{ "z": 1.0, "a": ["中", true] }"#).unwrap(),
            r#"{"z":1,"a":["中",true]}"#
        );
    }
    #[tokio::test]
    async fn transactional_extraction_lease_integrity_and_failure_retains_records() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::Database::open(dir.path().join("fixture.sqlite")).unwrap();
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        db.migrate(&root.join("migrations")).unwrap();
        let app = AppState::new(db.clone(), root, "127.0.0.1:8000".into()).unwrap();
        let body = "甲公司2026年营收十亿元";
        let meta = json!({"feed":{"fullBodyHash":sha256_text(body),"contentType":"news"},"informationExtraction":{"status":"pending","current":null}});
        db.execute("INSERT INTO knowledge_docs(doc_id,source_type,title,published_at,metadata_json,updated_at) VALUES('f_test','information_feed','甲公司业绩','2026-10-29T00:00:00Z',?,1)",vec![meta.to_string().into()]).await.unwrap();
        db.execute("INSERT INTO knowledge_doc_content_refs(doc_id,content_key,content_sha256,updated_at) VALUES('f_test','knowledge-content/test.md',?,1)",vec![sha256_text(body).into()]).await.unwrap();
        let row = db.run(|c| read_document(c, "f_test")).await.unwrap();
        let contract = extraction_contracts().unwrap()[0].clone();
        let fp = fingerprint(&row, body, &contract);
        assert!(
            claim(&app, &row, body, &contract, &fp, "owner")
                .await
                .unwrap()
        );
        assert!(
            !claim(&app, &row, body, &contract, &fp, "competitor")
                .await
                .unwrap()
        );
        let parsed=parse_extraction(r#"{"records":[{"entity":"甲公司","informationType":"fact","category":"revenue","period":"2026FY","statement":"甲公司营收十亿元"}],"categoryCandidates":[]}"#,body,&ontology()).unwrap();
        assert!(
            commit(
                &app,
                &row,
                body,
                &contract,
                &fp,
                "competitor",
                (&parsed, &json!([]))
            )
            .await
            .is_err()
        );
        commit(
            &app,
            &row,
            body,
            &contract,
            &fp,
            "owner",
            (&parsed, &json!([])),
        )
        .await
        .unwrap();
        let stored = db
            .query(
                "SELECT * FROM knowledge_information_records WHERE doc_id='f_test'",
                vec![],
            )
            .await
            .unwrap();
        assert_eq!(stored.len(), 1);
        let after = db.run(|c| read_document(c, "f_test")).await.unwrap();
        assert_eq!(
            after["meta"]["informationExtraction"]["current"]["recordsDigest"],
            sha256_text(&records_digest_input(&stored).unwrap())
        );
        let new_fp = "changed-contract-input";
        assert!(
            claim(&app, &row, body, &contract, new_fp, "later")
                .await
                .unwrap()
        );
        fail(&app, "f_test", "wrong-owner", "ignored")
            .await
            .unwrap();
        let processing = db.run(|c| read_document(c, "f_test")).await.unwrap();
        assert_eq!(
            processing["meta"]["informationExtraction"]["status"],
            "processing"
        );
        fail(&app, "f_test", "later", "model failed").await.unwrap();
        let failed = db.run(|c| read_document(c, "f_test")).await.unwrap();
        assert_eq!(failed["meta"]["informationExtraction"]["status"], "failed");
        assert_eq!(
            failed["meta"]["informationExtraction"]["current"],
            after["meta"]["informationExtraction"]["current"]
        );
        assert_eq!(
            db.query(
                "SELECT * FROM knowledge_information_records WHERE doc_id='f_test'",
                vec![]
            )
            .await
            .unwrap(),
            stored
        );
        assert!(
            claim(&app, &row, "tampered body", &contract, "other", "bad")
                .await
                .is_err()
        );
    }
    #[test]
    fn source_evidence_and_strict_shape() {
        let good = r#"{"records":[{"entity":"甲公司","informationType":"fact","category":"revenue","period":"2026Q1","statement":"甲公司营收十亿元"}],"categoryCandidates":[]}"#;
        let p = parse_extraction(good, "甲公司营收十亿元", &ontology()).unwrap();
        assert!(p["records"][0]["forecastMeasurement"].is_null());
        assert!(
            parse_extraction(&good.replace("2026Q1", "今年"), "不含期间", &ontology()).is_err()
        );
        assert!(
            parse_extraction(
                &good.replace("甲公司营收十亿元", "营收十亿元"),
                "",
                &ontology()
            )
            .is_err()
        );
        assert!(
            parse_extraction(
                &good.replace("\"records\":", "\"extra\":0,\"records\":"),
                "",
                &ontology()
            )
            .is_err()
        );
    }
    #[test]
    fn source_period_and_dates() {
        assert!(valid_period("今年", "今年增长"));
        assert!(!valid_period("今年", "增长"));
        assert!(valid_period("2024年2月28日至29日", "2024年2月28日至29日"));
        assert!(!valid_period("2023年2月28日至29日", "2023年2月28日至29日"));
        assert!(!valid_period("12月至1月", "12月至1月"));
    }
    #[test]
    fn retries_and_identity_are_stable() {
        let c = json!({"model":"test"});
        let fp = "abc";
        assert!(!should_attempt(
            &json!({"status":"processing","lastAttempt":{"leaseUntil":100}}),
            fp,
            &c,
            99
        ));
        assert!(!should_attempt(
            &json!({"status":"failed","lastAttempt":{"model":"test","inputFingerprint":fp,"attempts":5}}),
            fp,
            &c,
            1000
        ));
        let r = json!({"entity":"甲","informationType":"event","category":"order_backlog","period":null,"statement":"甲新增订单","forecastMeasurement":null});
        let rows = make_rows("f", fp, &[r.clone(), r], &json!([]), 1);
        assert_ne!(rows[0]["information_id"], rows[1]["information_id"]);
        assert_eq!(
            rows[0]["information_id"],
            make_rows(
                "f",
                fp,
                &[
                    json!({"entity":"甲","informationType":"event","category":"order_backlog","period":null,"statement":"甲新增订单","forecastMeasurement":null})
                ],
                &json!([]),
                2
            )[0]["information_id"]
        );
    }
}
