use super::information_records::{
    MAX_EXTRACTION_ATTEMPTS, contract_matches, current_extraction_sql, extraction_contracts,
    information_rows_json_sql, records_digest_input, row_to_information, sha256_text, sql_text,
};
use crate::{ApiError, ApiResult, AppState, ok};
use axum::{
    Router,
    extract::{Query, State},
    http::StatusCode,
    routing::get,
};
use base64::{
    Engine, alphabet,
    engine::{
        DecodePaddingMode,
        general_purpose::{GeneralPurpose, GeneralPurposeConfig, STANDARD},
    },
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::LazyLock,
};

type Params = HashMap<String, String>;
const CURRENT: &str = "$.informationExtraction.current";
const STATUSES: [&str; 7] = [
    "unclassified",
    "category_gap",
    "category_unassessed",
    "pending",
    "failed",
    "complete",
    "expired",
];

struct Catalog {
    contracts: Vec<Value>,
    categories: HashSet<String>,
    profiles: HashMap<String, Value>,
    names: HashMap<String, String>,
    industries: HashMap<String, String>,
    industry_companies: HashMap<String, Vec<String>>,
    labels: Value,
    max_age_hours: i64,
    relevance_version: String,
}

static CATALOG: LazyLock<Catalog> = LazyLock::new(|| {
    let ontology: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../config/knowledge/knowledge-ontology.json"
    )))
    .expect("knowledge ontology");
    let companies: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../config/generated/eastmoney-company-em2016-profiles.json"
    )))
    .expect("company profiles");
    let feed: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../config/knowledge/information-feed.json"
    )))
    .expect("feed configuration");
    let policy: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../config/knowledge/information-feed-policy.json"
    )))
    .expect("feed policy");
    let labels: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../web/src/config/information-feed-labels.json"
    )))
    .expect("feed labels");
    let categories = ontology["informationExtraction"]["categories"]
        .as_object()
        .expect("category map")
        .keys()
        .cloned()
        .collect();
    let mut profiles = HashMap::new();
    let mut names = HashMap::new();
    let mut industries = HashMap::new();
    let mut industry_companies: HashMap<String, Vec<String>> = HashMap::new();
    for item in companies["profiles"]
        .as_array()
        .expect("company profiles array")
    {
        let code = s(&item["code"]);
        profiles.insert(code.to_string(), item.clone());
        let key = format!("company:{code}");
        names.insert(key.clone(), s(&item["name"]).to_string());
        if item["availability"] == "available" && !s(&item["industry"]).is_empty() {
            let industry = s(&item["industry"]).to_string();
            industries.insert(key.clone(), industry.clone());
            industry_companies.entry(industry).or_default().push(key);
        }
    }
    Catalog {
        contracts: extraction_contracts().expect("generated feed contracts"),
        categories,
        profiles,
        names,
        industries,
        industry_companies,
        labels,
        max_age_hours: feed["automation"]["maxAgeHours"]
            .as_i64()
            .filter(|n| *n != 0)
            .unwrap_or(48),
        relevance_version: s(&policy["relevance"]["version"]).to_string(),
    }
});

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/knowledge/feed", get(list))
        .route("/knowledge/feed/facets", get(facets))
        .route("/knowledge/feed/story", get(story))
}
fn s(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
fn parse(value: &Value) -> Value {
    value
        .as_str()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(|| json!({}))
}
fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}
fn csv(value: Option<&String>) -> Vec<String> {
    let mut seen = HashSet::new();
    value
        .into_iter()
        .flat_map(|s| s.split(','))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .filter(|s| seen.insert(s.to_string()))
        .take(20)
        .map(str::to_string)
        .collect()
}
fn placeholders(count: usize) -> String {
    vec!["?"; count].join(",")
}
fn bad(message: &str) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message.into())
}
fn cutoff() -> String {
    (Utc::now() - chrono::Duration::hours(CATALOG.max_age_hours))
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn eligible() -> String {
    format!(
        "(d.source_type='information_feed' and d.access_method='markdown' and json_extract(d.metadata_json,'$.feed.version')='v1' and json_extract(d.metadata_json,'$.feed.originalFormat')='text' and json_extract(d.metadata_json,'$.feed.investmentGate.policyVersion')={} and json_extract(d.metadata_json,'$.feed.investmentGate.effectiveDisposition')='pass' and json_extract(d.metadata_json,'$.feed.investmentGate.title')=d.title and exists(select 1 from knowledge_doc_content_refs c where c.doc_id=d.doc_id and c.content_key is not null and c.content_sha256=json_extract(d.metadata_json,'$.feed.investmentGate.bodySha256'))) or (d.source_type='information_feed' and d.access_method='markdown' and json_extract(d.metadata_json,'$.feed.version')='v2' and json_extract(d.metadata_json,'$.feed.importVersion')='api-v1' and json_extract(d.metadata_json,'$.feed.originalFormat')='text' and json_extract(d.metadata_json,'$.feed.publishAllowed')=1 and ((d.inline_content is not null and d.inline_content_sha256=json_extract(d.metadata_json,'$.feed.fullBodyHash')) or exists(select 1 from knowledge_doc_content_refs c where c.doc_id=d.doc_id and c.content_key is not null and c.content_sha256=json_extract(d.metadata_json,'$.feed.fullBodyHash'))))",
        sql_text(&CATALOG.relevance_version)
    )
}
fn visible_cte() -> String {
    format!(
        "with ranked as (select d.doc_id,d.title,d.url,d.source_name,d.published_at,d.sort_time,d.summary,d.metadata_json,row_number() over(partition by json_extract(d.metadata_json,'$.feed.storyKey') order by d.sort_time desc,d.doc_id desc) as rn from knowledge_docs d where ({})), visible as(select * from ranked where rn=1)",
        eligible()
    )
}
fn select_fields(alias: &str) -> String {
    let contracts = CATALOG
        .contracts
        .iter()
        .map(|contract| sql_text(s(&contract["contractVersion"])))
        .collect::<Vec<_>>()
        .join(",");
    let tags = format!(
        "(select coalesce(json_group_array(json_object('tagId',t.tag,'weight',t.weight)),'[]') from knowledge_doc_tags t where t.doc_id={alias}.doc_id and (t.tag like 'company:%' or t.tag like 'category:%') and t.tagging_input_fingerprint=json_extract({alias}.metadata_json,'{CURRENT}.inputFingerprint') and t.contract_version=json_extract({alias}.metadata_json,'{CURRENT}.contractVersion') and t.contract_version in ({contracts}))"
    );
    format!(
        "{alias}.doc_id,{alias}.title,{alias}.url,{alias}.source_name,{alias}.published_at,{alias}.sort_time,{alias}.summary,{alias}.metadata_json,{tags} as tags_json,{} as records_json,{} as current_valid",
        information_rows_json_sql(alias).expect("constant SQL alias"),
        current_extraction_sql(alias, &CATALOG.contracts, true).expect("constant SQL alias")
    )
}

fn verified_rows(row: &Value) -> Option<Vec<Value>> {
    if row["current_valid"].as_i64().unwrap_or(0) == 0 {
        return None;
    }
    let metadata = parse(&row["metadata_json"]);
    let current = &metadata["informationExtraction"]["current"];
    let rows: Vec<Value> = serde_json::from_str(s(&row["records_json"])).ok()?;
    if rows.len() as u64 != current["recordCount"].as_u64()? {
        return None;
    }
    let digest = sha256_text(&records_digest_input(&rows).ok()?);
    (s(&current["recordsDigest"]) == digest).then_some(rows)
}

pub fn entity_facet_id(record: &Value) -> String {
    let key = s(&record["entity_key"]);
    if !key.is_empty() {
        return key.into();
    }
    format!("entity:{}", encode_component(s(&record["entity"])))
}
fn encode_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}
fn decode_entity(id: &str) -> Option<(Option<String>, Option<String>)> {
    if id.starts_with("company:") && id.encode_utf16().count() <= 200 {
        return Some((Some(id.into()), None));
    }
    if !id.starts_with("entity:") || id.len() > 900 {
        return None;
    }
    let name = percent_encoding::percent_decode_str(&id[7..])
        .decode_utf8()
        .ok()?
        .into_owned();
    if name.is_empty()
        || name.encode_utf16().count() > 200
        || format!("entity:{}", encode_component(&name)) != id
    {
        return None;
    }
    Some((None, Some(name)))
}
#[derive(Default)]
struct Filters {
    categories: Vec<String>,
    entities: Vec<String>,
    companies: Vec<String>,
    industries: Vec<String>,
}
impl Filters {
    fn active(&self) -> bool {
        !self.categories.is_empty()
            || !self.entities.is_empty()
            || !self.companies.is_empty()
            || !self.industries.is_empty()
    }
    fn matches(&self, row: &Value) -> bool {
        (self.categories.is_empty() || self.categories.iter().any(|c| c == s(&row["category"])))
            && (self.entities.is_empty() || self.entities.contains(&entity_facet_id(row)))
            && (self.companies.is_empty()
                || self.companies.iter().any(|c| c == s(&row["entity_key"])))
            && (self.industries.is_empty()
                || self.industries.iter().any(|c| c == s(&row["entity_key"])))
    }
}
fn map_row(row: &Value, cutoff: &str, filters: &Filters) -> anyhow::Result<Value> {
    let metadata = parse(&row["metadata_json"]);
    let extraction = &metadata["informationExtraction"];
    let valid_rows = verified_rows(row);
    let valid = valid_rows.is_some();
    let mut tags = if valid {
        serde_json::from_str::<Vec<Value>>(s(&row["tags_json"]))?
    } else {
        vec![]
    };
    let mut industries = vec![];
    for tag in &tags {
        if let Some(industry) = CATALOG.industries.get(s(&tag["tagId"]))
            && !industries.contains(industry)
        {
            industries.push(industry.clone());
        }
    }
    let mut rows = valid_rows.unwrap_or_default();
    if filters.active() {
        rows.sort_by_key(|row| !filters.matches(row));
    }
    let mut leading = HashSet::new();
    if let Some(row) = rows.first() {
        leading.insert(format!("category:{}", s(&row["category"])));
        leading.insert(s(&row["entity_key"]).to_string());
    }
    let raw_status = s(&extraction["status"]);
    let status = if metadata["feed"]["importVersion"] == "api-v1" {
        "source_only"
    } else if !valid && s(&row["sort_time"]) < cutoff {
        "expired"
    } else if (raw_status == "complete" && !valid) || raw_status.is_empty() {
        "pending"
    } else {
        raw_status
    };
    let gate = &metadata["feed"]["investmentGate"];
    let reason = s(&gate["reasonCodes"][0]);
    let evidence = strings(&gate["evidence"]);
    let first = evidence.first().map(String::as_str).unwrap_or("");
    let second = evidence.get(1).map(String::as_str).unwrap_or("");
    let company_name = if reason == "stock" {
        CATALOG
            .profiles
            .get(first)
            .and_then(|p| p["name"].as_str())
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .or_else(|| (second != first && !second.is_empty()).then(|| second.to_string()))
    } else {
        None
    };
    tags.sort_by(|a, b| {
        leading
            .contains(s(&b["tagId"]))
            .cmp(&leading.contains(s(&a["tagId"])))
            .then_with(|| {
                b["weight"]
                    .as_f64()
                    .unwrap_or(0.0)
                    .total_cmp(&a["weight"].as_f64().unwrap_or(0.0))
            })
    });
    let records = rows
        .iter()
        .map(|row| {
            let mut value = row_to_information(row)?;
            value["information_id"] = row["information_id"].clone();
            value["entity_key"] = row["entity_key"].clone();
            Ok(value)
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let mut item = json!({"content_type":metadata["feed"]["contentType"].as_str().filter(|s|!s.is_empty()).unwrap_or("news"),"kind":metadata["feed"]["kind"].as_str().filter(|s|!s.is_empty()).unwrap_or("new"),"story_key":metadata["feed"]["storyKey"].as_str().filter(|s|!s.is_empty()).unwrap_or(s(&row["doc_id"])),"tagging_status":status,"retry_exhausted":status=="failed"&&contract_matches(&extraction["lastAttempt"],&CATALOG.contracts[0])&&extraction["lastAttempt"]["attempts"].as_u64().unwrap_or(0)>=MAX_EXTRACTION_ATTEMPTS,"whitelist_match":if gate["effectiveDisposition"]=="pass" {json!({"reason_code":reason,"matched_keywords":strings(&gate["matchedKeywords"]),"evidence":evidence,"company_name":company_name,"stock_code":if reason=="stock"&&!first.is_empty(){Some(first)}else{None},"industry":if reason=="industry"&&!first.is_empty(){Some(first)}else{None}})}else{Value::Null},"sources":metadata["feed"]["sources"].as_array().into_iter().flatten().map(|source|source["sourceKey"].clone()).collect::<Vec<_>>(),"tags":tags,"industries":industries,"records":records,"category_candidates":if valid&&extraction["categoryCandidates"].is_array(){extraction["categoryCandidates"].clone()}else{Value::Null}});
    for key in [
        "doc_id",
        "title",
        "url",
        "source_name",
        "published_at",
        "sort_time",
        "summary",
    ] {
        item[key] = row[key].clone();
    }
    Ok(item)
}

fn parse_cursor(value: &str) -> Option<(String, String)> {
    if value.is_empty() || value.len() > 1024 {
        return None;
    }
    let decoder = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
    );
    let compact = value
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect::<Vec<_>>();
    let bytes = decoder.decode(compact).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    let time = value["time"].as_str()?;
    let id = value["id"].as_str()?;
    let valid_date = DateTime::parse_from_rfc3339(time).is_ok()
        || chrono::NaiveDate::parse_from_str(time, "%Y-%m-%d").is_ok()
        || chrono::NaiveDateTime::parse_from_str(time, "%Y-%m-%dT%H:%M:%S%.f").is_ok();
    if !valid_date || id.is_empty() || id.encode_utf16().count() > 200 {
        return None;
    }
    Some((time.into(), id.into()))
}
async fn list(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    let cutoff = cutoff();
    let sources = csv(query.get("source"));
    let content_types = csv(query.get("content_type"));
    let entities = csv(query.get("entity"));
    let companies = csv(query.get("company"));
    let categories = csv(query.get("category"));
    let industries = csv(query.get("industry"));
    let status = query.get("status").map(|s| s.trim()).unwrap_or("");
    if !status.is_empty() && !STATUSES.contains(&status) {
        return Err(bad("invalid feed status"));
    }
    if industries
        .iter()
        .any(|i| !CATALOG.industry_companies.contains_key(i))
    {
        return Err(bad("unknown industry"));
    }
    if categories.iter().any(|c| !CATALOG.categories.contains(c)) {
        return Err(bad("unknown category"));
    }
    let entity_filters = entities
        .iter()
        .map(|id| decode_entity(id))
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| bad("invalid entity"))?;
    let page_size = query
        .get("limit")
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n != 0.0)
        .unwrap_or(20.0)
        .floor()
        .clamp(1.0, 50.0) as usize;
    let cursor = query
        .get("cursor")
        .filter(|s| !s.is_empty())
        .map(|s| parse_cursor(s).ok_or_else(|| bad("invalid cursor")))
        .transpose()?;
    let mut conditions = vec!["v.rn=1".to_string()];
    let mut binds = vec![];
    let valid = current_extraction_sql("v", &CATALOG.contracts, true)?;
    let extraction_status =
        "coalesce(json_extract(v.metadata_json,'$.informationExtraction.status'),'pending')";
    if status.is_empty() {
        conditions.push(format!("not(v.sort_time<? and not({valid}) and coalesce(json_extract(v.metadata_json,'$.feed.importVersion'),'')!='api-v1')"));
        binds.push(json!(cutoff));
    }
    if !sources.is_empty() {
        conditions.push(format!("exists(select 1 from json_each(v.metadata_json,'$.feed.sources') src where json_extract(src.value,'$.sourceKey') in ({}))",placeholders(sources.len())));
        binds.extend(sources.iter().map(|s| json!(s)));
    }
    if !content_types.is_empty() {
        conditions.push(format!(
            "coalesce(json_extract(v.metadata_json,'$.feed.contentType'),'news') in ({})",
            placeholders(content_types.len())
        ));
        binds.extend(content_types.iter().map(|s| json!(s)));
    }
    let company_keys = companies
        .iter()
        .map(|c| format!("company:{}", c.strip_prefix("company:").unwrap_or(c)))
        .collect::<Vec<_>>();
    let mut industry_keys = vec![];
    for industry in &industries {
        for company in &CATALOG.industry_companies[industry] {
            if !industry_keys.contains(company) {
                industry_keys.push(company.clone());
            }
        }
    }
    if !entities.is_empty()
        || !company_keys.is_empty()
        || !categories.is_empty()
        || !industry_keys.is_empty()
    {
        let mut records = vec!["r.doc_id=v.doc_id".to_string()];
        if !entities.is_empty() {
            let keys = entity_filters
                .iter()
                .filter_map(|(key, _)| key.as_ref())
                .collect::<Vec<_>>();
            let names = entity_filters
                .iter()
                .filter_map(|(_, name)| name.as_ref())
                .collect::<Vec<_>>();
            let mut alternatives = vec![];
            if !keys.is_empty() {
                alternatives.push(format!("r.entity_key in ({})", placeholders(keys.len())));
                binds.extend(keys.into_iter().map(|s| json!(s)));
            }
            if !names.is_empty() {
                alternatives.push(format!(
                    "(r.entity_key is null and r.entity in ({}))",
                    placeholders(names.len())
                ));
                binds.extend(names.into_iter().map(|s| json!(s)));
            }
            records.push(format!("({})", alternatives.join(" or ")));
        }
        for (field, values) in [
            ("entity_key", &company_keys),
            ("category", &categories),
            ("entity_key", &industry_keys),
        ] {
            if !values.is_empty() {
                records.push(format!("r.{field} in ({})", placeholders(values.len())));
                binds.extend(values.iter().map(|s| json!(s)));
            }
        }
        conditions.push(format!(
            "{valid} and exists(select 1 from knowledge_information_records r where {})",
            records.join(" and ")
        ));
    }
    match status {
        "unclassified" => conditions.push(format!(
            "{valid} and json_extract(v.metadata_json,'{CURRENT}.outcome')='no_information'"
        )),
        "category_gap" => conditions.push(format!(
            "{valid} and json_extract(v.metadata_json,'{CURRENT}.categoryCandidateCount')>0"
        )),
        "category_unassessed" => conditions.push(format!(
            "{valid} and json_extract(v.metadata_json,'{CURRENT}.categoryCandidateCount') is null"
        )),
        "pending" => {
            conditions.push(format!("v.sort_time>=? and ({extraction_status}='pending' or ({extraction_status}='complete' and not({valid})))"));
            binds.push(json!(cutoff));
        }
        "expired" => {
            conditions.push(format!("v.sort_time<? and not({valid})"));
            binds.push(json!(cutoff));
        }
        "complete" => conditions.push(valid),
        "failed" => {
            conditions.push(format!("{extraction_status}='failed' and v.sort_time>=?"));
            binds.push(json!(cutoff));
        }
        _ => {}
    }
    if let Some((time, id)) = cursor {
        conditions.push("(v.sort_time<? or(v.sort_time=? and v.doc_id<?))".into());
        binds.extend([json!(time), json!(time), json!(id)]);
    }
    binds.push(json!(page_size + 1));
    let rows=state.db.query(format!("{} select {} from visible v where {} order by v.sort_time desc,v.doc_id desc limit ?",visible_cte(),select_fields("v"),conditions.join(" and ")),binds).await?;
    let has_next = rows.len() > page_size;
    let page = &rows[..rows.len().min(page_size)];
    let filters = Filters {
        categories,
        entities,
        companies: company_keys,
        industries: industry_keys,
    };
    let list = page
        .iter()
        .map(|row| map_row(row, &cutoff, &filters))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let next = if has_next {
        page.last().map(|row| {
            STANDARD.encode(
                serde_json::to_vec(&json!({"time":row["sort_time"],"id":row["doc_id"]})).unwrap(),
            )
        })
    } else {
        None
    };
    Ok(ok(
        json!({"list":list,"has_next":has_next,"next_cursor":next}),
    ))
}

fn options(map: BTreeMap<String, u64>) -> Vec<Value> {
    let mut options = map
        .into_iter()
        .map(|(id, count)| json!({"id":id,"count":count}))
        .collect::<Vec<_>>();
    options.sort_by(|a, b| {
        b["count"]
            .as_u64()
            .cmp(&a["count"].as_u64())
            .then_with(|| s(&a["id"]).cmp(s(&b["id"])))
    });
    options
}
fn increment(map: &mut BTreeMap<String, u64>, key: &str) {
    *map.entry(key.into()).or_default() += 1;
}
async fn facets(State(state): State<AppState>) -> ApiResult {
    let cutoff = cutoff();
    let rows = state
        .db
        .query(
            format!(
                "{} select {} from visible v",
                visible_cte(),
                select_fields("v")
            ),
            vec![],
        )
        .await?;
    let mut sources = BTreeMap::new();
    let mut content_types = BTreeMap::new();
    let mut companies = BTreeMap::new();
    let mut entities: BTreeMap<String, (u64, String)> = BTreeMap::new();
    let mut categories = BTreeMap::new();
    let mut industries = BTreeMap::new();
    for row in &rows {
        let item = map_row(row, &cutoff, &Filters::default())?;
        if item["tagging_status"] == "expired" {
            continue;
        }
        increment(&mut content_types, s(&item["content_type"]));
        for source in strings(&item["sources"])
            .into_iter()
            .collect::<HashSet<_>>()
        {
            increment(&mut sources, &source);
        }
        for tag in item["tags"].as_array().into_iter().flatten() {
            let id = s(&tag["tagId"]);
            increment(
                if id.starts_with("company:") {
                    &mut companies
                } else {
                    &mut categories
                },
                id,
            );
        }
        let mut seen = HashSet::new();
        for record in item["records"].as_array().into_iter().flatten() {
            let id = entity_facet_id(record);
            if !seen.insert(id.clone()) {
                continue;
            }
            let label = if let Some(code) = id.strip_prefix("company:") {
                format!(
                    "{}（{code}）",
                    CATALOG
                        .names
                        .get(&id)
                        .map(String::as_str)
                        .unwrap_or(s(&record["entity"]))
                )
            } else {
                s(&record["entity"]).to_string()
            };
            entities
                .entry(id)
                .and_modify(|value| value.0 += 1)
                .or_insert((1, label));
        }
        for industry in strings(&item["industries"]) {
            increment(&mut industries, &industry);
        }
    }
    let mut entities = entities
        .into_iter()
        .map(|(id, (count, label))| json!({"id":id,"count":count,"label":label}))
        .collect::<Vec<_>>();
    entities.sort_by(|a, b| {
        b["count"]
            .as_u64()
            .cmp(&a["count"].as_u64())
            .then_with(|| s(&a["label"]).cmp(s(&b["label"])))
    });
    let companies = options(companies)
        .into_iter()
        .map(|mut item| {
            let id = s(&item["id"]);
            let label = CATALOG
                .names
                .get(id)
                .map(String::as_str)
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| id.strip_prefix("company:").unwrap_or(id))
                .to_string();
            item["label"] = json!(label);
            item
        })
        .collect::<Vec<_>>();
    let categories = options(categories)
        .into_iter()
        .map(|mut item| {
            let id = s(&item["id"]);
            let label = CATALOG.labels["categories"][id.strip_prefix("category:").unwrap_or(id)]
                .as_str()
                .unwrap_or(id)
                .to_string();
            item["label"] = json!(label);
            item
        })
        .collect::<Vec<_>>();
    Ok(ok(
        json!({"sources":options(sources),"content_types":options(content_types),"entities":entities,"companies":companies,"categories":categories,"industries":options(industries),"statuses":STATUSES}),
    ))
}
async fn story(State(state): State<AppState>, Query(query): Query<Params>) -> ApiResult {
    let key = query.get("key").map(|s| s.trim()).unwrap_or("");
    if !regex::Regex::new(r"^f_[a-f0-9]{24}$")
        .unwrap()
        .is_match(key)
    {
        return Err(bad("invalid story key"));
    }
    let rows=state.db.query(format!("select {} from knowledge_docs d where ({}) and json_extract(d.metadata_json,'$.feed.storyKey')=? order by d.sort_time,d.doc_id limit 100",select_fields("d"),eligible()),vec![json!(key)]).await?;
    let cutoff = cutoff();
    let list = rows
        .iter()
        .map(|row| map_row(row, &cutoff, &Filters::default()))
        .collect::<anyhow::Result<Vec<_>>>()?;
    Ok(ok(json!({"list":list})))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn facet_identity_requires_canonical_encoding_and_cursor_is_bounded() {
        let record = json!({"entity":"中国&银行","entity_key":null});
        let id = entity_facet_id(&record);
        assert_eq!(id, "entity:%E4%B8%AD%E5%9B%BD%26%E9%93%B6%E8%A1%8C");
        assert_eq!(decode_entity(&id), Some((None, Some("中国&银行".into()))));
        assert!(decode_entity("entity:%e4%b8%ad").is_none());
        assert!(decode_entity("entity:%GG").is_none());
        assert!(decode_entity("entity:").is_none());
        assert!(parse_cursor(&"a".repeat(1025)).is_none());
        assert!(parse_cursor(&STANDARD.encode(r#"{"time":"bad","id":"a"}"#)).is_none());
    }
    #[test]
    fn corrupt_record_digest_never_exposes_records_or_tags() {
        let row = json!({"current_valid":1,"metadata_json":json!({"informationExtraction":{"status":"complete","current":{"recordCount":0,"recordsDigest":"wrong"}}}).to_string(),"records_json":"[]","tags_json":"[{\"tagId\":\"company:600036.SH\",\"weight\":100}]","sort_time":"2999-01-01"});
        assert!(verified_rows(&row).is_none());
        let item = map_row(&row, "2026-10-29", &Filters::default()).unwrap();
        assert_eq!(item["tagging_status"], "pending");
        assert_eq!(item["records"], json!([]));
        assert_eq!(item["tags"], json!([]));
    }
}
