//! Local identity-universe maintenance. Provider coverage is validated before
//! opening an all-or-nothing write transaction; existing curated names survive.
use crate::{AppState, db::Database};
use anyhow::{Context, Result, bail};
use futures_util::{StreamExt, stream};
use reqwest::{Method, Url, header::HeaderMap};
use rusqlite::params;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    time::Duration,
};

const SP500: &str =
    "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv";
#[derive(Clone, Debug)]
struct Stock {
    code: String,
    name: String,
    aliases: Vec<String>,
    levels: Option<[String; 3]>,
}
fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("").trim()
}
fn count(v: &Value, k: &str, default: usize, max: usize) -> Result<usize> {
    let n = match v.get(k) {
        None | Some(Value::Null) => default,
        Some(n) => n
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .context(format!("{k} must be a nonnegative integer"))?,
    };
    if n > max {
        bail!("{k} must not exceed {max}");
    }
    Ok(n)
}
fn database(state: &AppState, options: &Value) -> Result<Database> {
    let selected = text(options, "db");
    if selected.is_empty() {
        return Ok(state.db.clone());
    }
    let path = state.root.join(selected);
    if !path.is_file() {
        bail!("selected database does not exist; migrate it explicitly first");
    }
    Database::open(path)
}
fn database_path(state: &AppState, options: &Value) -> std::path::PathBuf {
    let explicit = text(options, "db");
    if !explicit.is_empty() {
        return state.root.join(explicit);
    }
    let configured = state.setting("LOCAL_DB_PATH");
    if configured.is_empty() {
        state.data_dir().join("stock-info.sqlite")
    } else {
        state.root.join(configured)
    }
}

async fn fetch(state: &AppState, url: Url, headers: HeaderMap) -> Result<Value> {
    let mut last = None;
    for attempt in 0..3 {
        match state
            .http
            .text_once(url.as_str(), Method::GET, headers.clone(), None, 20_000)
            .await
            .and_then(|s| serde_json::from_str(&s).map_err(Into::into))
        {
            Ok(v) => return Ok(v),
            Err(e) => last = Some(e),
        }
        if attempt < 2 {
            tokio::time::sleep(Duration::from_millis((attempt + 1) * 500)).await;
        }
    }
    Err(last.context("provider request failed")?)
}
fn csv(input: &str) -> Result<Vec<Vec<String>>> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = input.trim_start_matches('\u{feff}').chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                if quoted && chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    quoted = !quoted;
                }
            }
            ',' if !quoted => {
                row.push(std::mem::take(&mut field));
            }
            '\n' | '\r' if !quoted => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
                if c == '\r' && chars.peek() == Some(&'\n') {
                    chars.next();
                }
            }
            _ => field.push(c),
        }
    }
    if quoted {
        bail!("unterminated quoted CSV field");
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    Ok(rows)
}
fn constituents(input: &str) -> Result<Vec<Stock>> {
    let mut rows = csv(input)?.into_iter();
    let header = rows.next().context("missing CSV header")?;
    let symbol = header
        .iter()
        .position(|s| s == "Symbol")
        .context("missing Symbol column")?;
    let name = header
        .iter()
        .position(|s| s == "Security")
        .context("missing Security column")?;
    let valid = regex::Regex::new(r"^[A-Z][A-Z0-9]*(?:\.[A-Z0-9]+)?$")?;
    let mut seen = BTreeSet::new();
    let mut stocks = Vec::new();
    for row in rows.filter(|r| r.iter().any(|s| !s.trim().is_empty())) {
        let symbol = row
            .get(symbol)
            .map(|s| s.trim().to_uppercase())
            .unwrap_or_default();
        let name = row
            .get(name)
            .map(|s| s.trim().to_owned())
            .unwrap_or_default();
        if !valid.is_match(&symbol) || name.is_empty() || !seen.insert(symbol.clone()) {
            bail!("invalid or duplicate S&P constituent");
        }
        stocks.push(Stock {
            code: format!("{symbol}.US"),
            aliases: vec![name.to_lowercase()],
            name,
            levels: None,
        });
    }
    if !(450..=550).contains(&stocks.len()) {
        bail!(
            "unexpected S&P constituent count {}; refusing partial import",
            stocks.len()
        );
    }
    Ok(stocks)
}
fn asia(value: &Value) -> Result<Vec<Stock>> {
    let rows = value["stocks"]
        .as_array()
        .filter(|a| !a.is_empty())
        .context("manifest requires nonempty stocks array")?;
    let valid = regex::Regex::new(r"^(?:\d{6}\.KS|\d{4}\.T)$")?;
    let mut seen = BTreeSet::new();
    let mut stocks = Vec::new();
    for row in rows {
        let code = text(row, "code").to_uppercase();
        let name = text(row, "name").to_owned();
        let aliases = row["aliases"]
            .as_array()
            .context("aliases must be an array")?;
        if !valid.is_match(&code)
            || name.is_empty()
            || !seen.insert(code.clone())
            || aliases
                .iter()
                .any(|a| a.as_str().is_none_or(|a| a.trim().is_empty()))
        {
            bail!("invalid or duplicate Asia stock identity");
        }
        let aliases = std::iter::once(name.as_str())
            .chain(aliases.iter().filter_map(Value::as_str))
            .map(|s| s.trim().to_lowercase())
            .filter(|a| {
                a != &code.to_lowercase() && a != &code.rsplit_once('.').unwrap().0.to_lowercase()
            })
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        stocks.push(Stock {
            code,
            name,
            aliases,
            levels: None,
        });
    }
    Ok(stocks)
}
async fn store(
    db: &Database,
    stocks: Vec<Stock>,
    source: &'static str,
    industries: bool,
) -> Result<()> {
    db.run(move|conn|{
        let tx=conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let now=chrono::Utc::now().timestamp_millis();
        for stock in &stocks {
            if industries {
                let levels=stock.levels.as_ref().context("missing industry taxonomy")?;
                tx.execute("INSERT INTO stock(code,short_name,industry_level_1,industry_level_2,industry_level_3,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET industry_level_1=excluded.industry_level_1,industry_level_2=excluded.industry_level_2,industry_level_3=excluded.industry_level_3 WHERE stock.industry_level_1 IS NOT excluded.industry_level_1 OR stock.industry_level_2 IS NOT excluded.industry_level_2 OR stock.industry_level_3 IS NOT excluded.industry_level_3",params![stock.code,stock.name,levels[0],levels[1],levels[2],now])?;
            }else{tx.execute("INSERT INTO stock(code,short_name,updated_at) VALUES(?,?,?) ON CONFLICT(code) DO NOTHING",params![stock.code,stock.name,now])?;}
            for alias in &stock.aliases {tx.execute("INSERT INTO stock_alias(alias,code,source,updated_at) VALUES(?,?,?,?) ON CONFLICT(alias,code) DO NOTHING",params![alias,stock.code,source,now])?;}
        }
        for stock in &stocks {
            let count:i64=tx.query_row("SELECT count(*) FROM stock WHERE code=?",[&stock.code],|r|r.get(0))?;
            if count!=1{bail!("failed to verify stock identity");}
            if let Some(levels)=&stock.levels {
                let actual:[String;3]=tx.query_row("SELECT industry_level_1,industry_level_2,industry_level_3 FROM stock WHERE code=?",[&stock.code],|r|Ok([r.get(0)?,r.get(1)?,r.get(2)?]))?;
                if actual!=*levels{bail!("failed to verify industry taxonomy");}
            }
            for alias in &stock.aliases {let count:i64=tx.query_row("SELECT count(*) FROM stock_alias WHERE alias=? AND code=?",params![alias,stock.code],|r|r.get(0))?;if count!=1{bail!("failed to verify stock alias");}}
        } tx.commit()?;Ok(())
    }).await
}
async fn index(state: &AppState, code: &str) -> Result<(String, String, Vec<Stock>)> {
    let valid = regex::Regex::new(r"^\d{6}\.(?:SH|SZ|BJ)$")?;
    let mut stocks = Vec::new();
    let mut seen = BTreeSet::new();
    let mut name = String::new();
    let mut expected = 0;
    for page in 1..20 {
        let mut url = Url::parse("https://datacenter-web.eastmoney.com/api/data/v1/get")?;
        url.query_pairs_mut().extend_pairs([
            ("reportName", "RPT_INDEX_CONSTITUENT"),
            (
                "columns",
                "SECUCODE,SECURITY_NAME_ABBR,INDEX_CODE,INDEX_NAME",
            ),
            ("filter", &format!("(INDEX_CODE=\"{code}\")")),
            ("pageNumber", &page.to_string()),
            ("pageSize", "2000"),
            ("source", "WEB"),
            ("client", "WEB"),
        ]);
        let body = fetch(state, url, HeaderMap::new()).await?;
        let rows = body["result"]["data"]
            .as_array()
            .context("invalid constituent provider response")?;
        expected = body["result"]["count"]
            .as_u64()
            .context("invalid constituent count")? as usize;
        if body["success"] != true {
            bail!("index provider rejected request");
        }
        for row in rows {
            let security = text(row, "SECUCODE").to_uppercase();
            let short = text(row, "SECURITY_NAME_ABBR").to_owned();
            if !valid.is_match(&security)
                || short.is_empty()
                || text(row, "INDEX_CODE") != code
                || !seen.insert(security.clone())
            {
                bail!("invalid or duplicated CSI constituent");
            }
            if !text(row, "INDEX_NAME").is_empty() {
                name = text(row, "INDEX_NAME").to_owned();
            }
            stocks.push(Stock {
                code: security,
                name: short.clone(),
                aliases: vec![short.to_lowercase()],
                levels: None,
            });
        }
        if stocks.len() >= expected {
            break;
        }
    }
    let known = match code {
        "000906" => Some(800),
        "000852" => Some(1000),
        _ => None,
    };
    if expected == 0 || stocks.len() != expected || known.is_some_and(|n| n != expected) {
        bail!("incomplete CSI index coverage");
    }
    Ok((code.to_owned(), name, stocks))
}
async fn profile_batch(state: &AppState, batch: Vec<Stock>) -> Result<Vec<Stock>> {
    let mut url = Url::parse("https://datacenter.eastmoney.com/securities/api/data/v1/get")?;
    let filter = format!(
        "(SECUCODE in ({}))",
        batch
            .iter()
            .map(|s| format!("\"{}\"", s.code))
            .collect::<Vec<_>>()
            .join(",")
    );
    url.query_pairs_mut().extend_pairs([
        ("reportName", "RPT_F10_ORG_BASICINFO"),
        ("columns", "SECUCODE,SECURITY_NAME_ABBR,EM2016"),
        ("quoteColumns", ""),
        ("filter", &filter),
        ("pageNumber", "1"),
        ("pageSize", &batch.len().to_string()),
        ("source", "HSF10"),
        ("client", "PC"),
    ]);
    let mut headers = HeaderMap::new();
    headers.insert(
        "referer",
        "https://emweb.securities.eastmoney.com/".parse()?,
    );
    let body = fetch(state, url, headers).await?;
    let rows = body["result"]["data"]
        .as_array()
        .context("invalid EM2016 response")?;
    if body["success"] != true
        || body["result"]["count"].as_u64() != Some(batch.len() as u64)
        || rows.len() != batch.len()
    {
        bail!("incomplete EM2016 batch");
    }
    let mut expected = batch
        .iter()
        .map(|s| s.code.clone())
        .collect::<BTreeSet<_>>();
    let mut out = BTreeMap::new();
    for row in rows {
        let code = text(row, "SECUCODE").to_uppercase();
        let name = text(row, "SECURITY_NAME_ABBR").to_owned();
        let levels = text(row, "EM2016")
            .split('-')
            .map(|s| s.trim().to_owned())
            .collect::<Vec<_>>();
        if !expected.remove(&code)
            || name.is_empty()
            || levels.len() != 3
            || levels.iter().any(String::is_empty)
        {
            bail!("missing or malformed EM2016 profile");
        }
        out.insert(
            code.clone(),
            Stock {
                code,
                name: name.clone(),
                aliases: vec![name.to_lowercase()],
                levels: Some(levels.try_into().unwrap()),
            },
        );
    }
    if !expected.is_empty() {
        bail!("missing EM2016 profiles");
    }
    Ok(batch
        .into_iter()
        .map(|s| out.remove(&s.code).unwrap())
        .collect())
}
async fn ranked(state: &AppState, field: &str, wanted: usize) -> Result<Vec<Stock>> {
    let valid = regex::Regex::new(r"^\d{5}$")?;
    let mut stocks = Vec::new();
    let mut seen = BTreeSet::new();
    let mut previous = f64::INFINITY;
    for page in 1..=20 {
        if stocks.len() == wanted {
            break;
        }
        let mut url = Url::parse("https://push2.eastmoney.com/webguest/api/qt/clist/get")?;
        url.query_pairs_mut().extend_pairs([
            ("pn", page.to_string().as_str()),
            ("pz", "100"),
            ("po", "1"),
            ("np", "1"),
            ("fltt", "2"),
            ("invt", "2"),
            ("fid", field),
            ("fields", "f12,f13,f14,f20,f6"),
            ("fs", "m:116+t:3"),
            ("ut", "fa5fd1943c7b386f172d6893dbfba10b"),
            ("wbp2u", "|0|0|0|web"),
        ]);
        let mut headers = HeaderMap::new();
        headers.insert("referer", "https://quote.eastmoney.com/".parse()?);
        headers.insert("user-agent", "Mozilla/5.0".parse()?);
        let body = fetch(state, url, headers).await?;
        let rows = body["data"]["diff"]
            .as_array()
            .context("invalid HK ranking response")?;
        if body["rc"] != 0
            || body["data"]["total"]
                .as_u64()
                .is_none_or(|n| n < (wanted as u64))
            || rows.is_empty()
        {
            bail!("incomplete HK ranking");
        }
        for row in rows {
            let code = text(row, "f12");
            let name = text(row, "f14");
            let metric = crate::http::number(&row[field]).context("invalid HK ranking metric")?;
            if !valid.is_match(code)
                || name.is_empty()
                || row["f13"] != 116
                || metric < 0.0
                || metric > previous
                || !seen.insert(code.to_owned())
            {
                bail!("invalid or unordered/duplicate HK ranking identity");
            }
            previous = metric;
            if code.starts_with('8')
                || crate::http::number(&row["f20"]).is_none_or(|n| n <= 0.0)
                || (field == "f6" && metric == 0.0)
            {
                continue;
            }
            stocks.push(Stock {
                code: format!("{code}.HK"),
                name: name.to_owned(),
                aliases: vec![name.to_lowercase()],
                levels: None,
            });
            if stocks.len() == wanted {
                break;
            }
        }
    }
    if stocks.len() != wanted {
        bail!("incomplete HK ranking coverage");
    }
    Ok(stocks)
}

pub async fn run(state: &AppState, operation: &str, options: &Value) -> Result<Value> {
    if options["remote"] == true {
        bail!("remote Cloudflare writes are retired");
    }
    let apply = options["apply"] == true && options["dryRun"] != true;
    match operation {
        "sp500" => {
            let input = text(options, "input");
            let body = if input.is_empty() {
                state
                    .http
                    .text_with_timeout(SP500, Method::GET, HeaderMap::new(), None, 30_000)
                    .await?
            } else {
                fs::read_to_string(state.root.join(input))?
            };
            let stocks = constituents(&body)?;
            let len = stocks.len();
            let statements = len + stocks.iter().map(|s| s.aliases.len()).sum::<usize>();
            let dry = options["dryRun"] == true;
            if !dry {
                store(
                    &database(state, options)?,
                    stocks,
                    "sp500_constituents",
                    false,
                )
                .await?;
            }
            Ok(
                json!({"source":if input.is_empty(){SP500}else{input},"target":if dry{"dry-run"}else{"local"},"securities":len,"statements":statements}),
            )
        }
        "asia-popular" => {
            let file = text(options, "manifest");
            let file = state.root.join(if file.is_empty() {
                "config/asia-popular-stocks.json"
            } else {
                file
            });
            let stocks = asia(&serde_json::from_slice::<Value>(&fs::read(&file)?)?)?;
            let japanese = stocks.iter().filter(|s| s.code.ends_with(".T")).count();
            let korean = stocks.len() - japanese;
            let statements = stocks.len() + stocks.iter().map(|s| s.aliases.len()).sum::<usize>();
            let dry = options["dryRun"] == true;
            if !dry {
                store(
                    &database(state, options)?,
                    stocks,
                    "curated_asia_popular",
                    false,
                )
                .await?;
            }
            Ok(
                json!({"manifest":file,"target":if dry{"dry-run"}else{"local"},"korean":korean,"japanese":japanese,"statements":statements}),
            )
        }
        "csi" => {
            let indexes = if let Some(rows) = options["indexes"].as_array() {
                rows.iter()
                    .map(|v| v.as_str().unwrap_or("").trim().to_owned())
                    .collect::<Vec<_>>()
            } else if !text(options, "indexes").is_empty() {
                text(options, "indexes")
                    .split(',')
                    .map(|s| s.trim().to_owned())
                    .collect()
            } else {
                vec!["000906".into(), "000852".into()]
            };
            let valid = regex::Regex::new(r"^\d{6}$")?;
            let unique = indexes.iter().collect::<BTreeSet<_>>();
            if indexes.is_empty()
                || unique.len() != indexes.len()
                || indexes.iter().any(|s| !valid.is_match(s))
            {
                bail!("indexes require unique six-digit CSI codes");
            }
            let batch = count(options, "batchSize", 80, 100)?;
            let concurrency = count(options, "concurrency", 4, 12)?;
            if batch == 0 || concurrency == 0 {
                bail!("batchSize and concurrency must be positive");
            }
            let results = stream::iter(indexes.iter().map(|code| index(state, code)))
                .buffered(concurrency)
                .collect::<Vec<_>>()
                .await;
            let mut stocks = BTreeMap::new();
            let mut index_summary = Vec::new();
            for result in results {
                let (code, name, rows) = result?;
                index_summary.push(json!({"code":code,"name":name,"constituents":rows.len()}));
                for item in rows {
                    if stocks
                        .get(&item.code)
                        .is_some_and(|old: &Stock| old.name != item.name)
                    {
                        bail!("conflicting CSI constituent names");
                    }
                    stocks.insert(item.code.clone(), item);
                }
            }
            let stocks = stocks.into_values().collect::<Vec<_>>();
            let chunks = stocks
                .chunks(batch)
                .map(<[Stock]>::to_vec)
                .collect::<Vec<_>>();
            let batches = stream::iter(chunks.into_iter().map(|batch| profile_batch(state, batch)))
                .buffered(concurrency)
                .collect::<Vec<_>>()
                .await;
            let mut profiles = Vec::new();
            for result in batches {
                profiles.extend(result?);
            }
            let db = database(state, options)?;
            let existing = db
                .query(
                    "SELECT code,industry_level_1,industry_level_2,industry_level_3 FROM stock",
                    vec![],
                )
                .await?
                .into_iter()
                .map(|row| (text(&row, "code").to_owned(), row))
                .collect::<BTreeMap<_, _>>();
            let new = profiles
                .iter()
                .filter(|s| !existing.contains_key(&s.code))
                .count();
            let changed = profiles
                .iter()
                .filter(|s| {
                    existing.get(&s.code).is_none_or(|old| {
                        s.levels
                            .as_ref()
                            .unwrap()
                            .iter()
                            .enumerate()
                            .any(|(i, v)| old[format!("industry_level_{}", i + 1)] != *v)
                    })
                })
                .count();
            let len = profiles.len();
            if apply {
                store(&db, profiles, "eastmoney_csi_constituent", true).await?;
            }
            let classified = if apply {
                db.query("SELECT count(*) AS n FROM stock WHERE industry_level_1 IS NOT NULL AND industry_level_2 IS NOT NULL AND industry_level_3 IS NOT NULL",vec![]).await?[0]["n"].clone()
            } else {
                Value::Null
            };
            Ok(
                json!({"mode":if apply{"applied"}else{"dry-run"},"database":database_path(state,options),"indexes":index_summary,"uniqueStocks":len,"newStocks":new,"changedIndustryRows":changed,"classifiedStocksAfterApply":classified,"aliasKinds":["eastmoney_name"]}),
            )
        }
        "hk-popular" => {
            let cap = count(options, "marketCapCount", 200, 1000)?;
            let turnover = count(options, "turnoverCount", 100, 1000)?;
            if cap + turnover == 0 {
                bail!("select at least one HK ranking");
            }
            let (largest, traded) =
                tokio::try_join!(ranked(state, "f20", cap), ranked(state, "f6", turnover))?;
            let caplen = largest.len();
            let tradelen = traded.len();
            let stocks = largest
                .into_iter()
                .chain(traded)
                .map(|s| (s.code.clone(), s))
                .collect::<BTreeMap<_, _>>()
                .into_values()
                .collect::<Vec<_>>();
            let len = stocks.len();
            let db = database(state, options)?;
            let existing = db
                .query("SELECT code FROM stock WHERE code LIKE '%.HK'", vec![])
                .await?
                .into_iter()
                .map(|r| text(&r, "code").to_owned())
                .collect::<BTreeSet<_>>();
            let new = stocks
                .iter()
                .filter(|s| !existing.contains(&s.code))
                .count();
            if apply {
                store(&db, stocks, "eastmoney_hk_popular", false).await?;
            }
            Ok(
                json!({"mode":if apply{"applied"}else{"dry-run"},"database":database_path(state,options),"source":"Eastmoney HK main-board market-cap and turnover rankings","marketCapCount":caplen,"turnoverCount":tradelen,"uniqueStocks":len,"newStocks":new,"excluded":"RMB duplicate counters (8xxxx.HK) and GEM stocks","industry":"not set: HK f100 is not the mainland EM2016 three-level taxonomy"}),
            )
        }
        _ => bail!("unknown stock universe operation"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn csv_quotes_and_coverage_are_fail_closed() {
        assert_eq!(
            csv("\u{feff}Symbol,Security\r\nBRK.B,\"Berkshire, Inc\"\r\n").unwrap()[1],
            vec!["BRK.B", "Berkshire, Inc"]
        );
        assert!(csv("x,\"unfinished").is_err());
        assert!(constituents("Symbol,Security\nAAPL,Apple").is_err());
        let rows = (0..450)
            .map(|n| format!("A{n},Company {n}\n"))
            .collect::<String>();
        let csv = format!("Symbol,Security\n{rows}");
        assert_eq!(constituents(&csv).unwrap().len(), 450);
        assert!(constituents(&(csv + "A0,Duplicate\n")).is_err());
    }
    #[test]
    fn manifest_identity_and_aliases_remain_curated() {
        let rows=asia(&json!({"stocks":[{"code":"005930.ks","name":"Samsung","aliases":["삼성전자","005930","005930.KS","Samsung"]}]})).unwrap();
        assert_eq!(rows[0].code, "005930.KS");
        assert_eq!(rows[0].aliases, vec!["samsung", "삼성전자"]);
        assert!(asia(&json!({"stocks":[{"code":"005930.KS","name":"x","aliases":[""]}]})).is_err());
        assert!(asia(&json!({"stocks":[{"code":"AAPL.US","name":"x","aliases":[]}]})).is_err());
    }
    #[tokio::test]
    async fn writes_preserve_existing_names_and_aliases_and_atomic_industry() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(temp.path().join("stock.sqlite")).unwrap();
        db.migrate(&std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../migrations"))
            .unwrap();
        db.execute(
            "INSERT INTO stock(code,short_name,updated_at) VALUES('600036.SH','curated',1) ON CONFLICT(code) DO UPDATE SET short_name=excluded.short_name,updated_at=excluded.updated_at",
            vec![],
        )
        .await
        .unwrap();
        let stock = Stock {
            code: "600036.SH".into(),
            name: "new provider name".into(),
            aliases: vec!["provider".into()],
            levels: Some(["金融".into(), "银行".into(), "股份制银行".into()]),
        };
        store(&db, vec![stock.clone()], "eastmoney_csi_constituent", true)
            .await
            .unwrap();
        store(&db, vec![stock], "eastmoney_csi_constituent", true)
            .await
            .unwrap();
        let rows = db
            .query(
                "SELECT short_name,industry_level_3,updated_at FROM stock WHERE code='600036.SH'",
                vec![],
            )
            .await
            .unwrap();
        assert_eq!(rows[0]["short_name"], "curated");
        assert_eq!(rows[0]["updated_at"], 1);
        assert_eq!(rows[0]["industry_level_3"], "股份制银行");
        let count = db
            .query(
                "SELECT count(*) AS n FROM stock_alias WHERE alias='provider'",
                vec![],
            )
            .await
            .unwrap();
        assert_eq!(count[0]["n"], 1);
        // A failure late in a batch must also undo the earlier identity and
        // industry writes, not merely leave each individual upsert idempotent.
        db.execute("CREATE TRIGGER reject_fixture_alias BEFORE INSERT ON stock_alias WHEN NEW.alias='fixture-reject' BEGIN SELECT RAISE(ABORT,'fixture alias rejected'); END",vec![]).await.unwrap();
        let failure = store(
            &db,
            vec![
                Stock {
                    code: "600036.SH".into(),
                    name: "must not replace curated".into(),
                    aliases: vec!["fixture-rollback".into()],
                    levels: Some(["bad".into(), "bad".into(), "bad".into()]),
                },
                Stock {
                    code: "600000.SH".into(),
                    name: "later failure".into(),
                    aliases: vec!["fixture-reject".into()],
                    levels: Some(["bad".into(), "bad".into(), "bad".into()]),
                },
            ],
            "eastmoney_csi_constituent",
            true,
        )
        .await;
        assert!(failure.is_err());
        let rows = db
            .query(
                "SELECT short_name,industry_level_3 FROM stock WHERE code='600036.SH'",
                vec![],
            )
            .await
            .unwrap();
        assert_eq!(rows[0]["short_name"], "curated");
        assert_eq!(rows[0]["industry_level_3"], "股份制银行");
        let aliases = db
            .query(
                "SELECT count(*) AS n FROM stock_alias WHERE alias='fixture-rollback'",
                vec![],
            )
            .await
            .unwrap();
        assert_eq!(aliases[0]["n"], 0);
    }
}
