//! Integrity boundary shared by feed readers and extraction writers.
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub const MAX_EXTRACTION_ATTEMPTS: u64 = 5;
pub const INFORMATION_STORAGE_VERSION: &str = "information-records-v1";

pub fn extraction_contracts() -> Result<Vec<Value>> {
    let generated: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../config/generated/information-records-contract.json"
    )))?;
    let mut contracts = vec![generated["current"].clone()];
    contracts.extend(
        generated["legacy"]
            .as_array()
            .context("legacy contracts must be an array")?
            .iter()
            .cloned(),
    );
    Ok(contracts)
}

pub fn canonical_json(value: &Value) -> String {
    match value {
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let mut keys: Vec<_> = values.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap(),
                        canonical_json(&values[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Value::Number(number) => {
            // JS source canonicalJson hashes Number.toString, not Rust's
            // distinction between 100 and 100.0. Keep historical hashes valid.
            let number = number.as_f64().unwrap();
            if number == 0.0 {
                "0".into()
            } else {
                ryu_js::Buffer::new().format_finite(number).to_string()
            }
        }
        _ => serde_json::to_string(value).unwrap(),
    }
}

pub fn row_to_information(row: &Value) -> Result<Value> {
    let measurement: Value = serde_json::from_str(
        row["forecast_measurement_json"]
            .as_str()
            .context("missing forecast measurement")?,
    )?;
    if !measurement.is_object() {
        bail!("invalid stored forecast measurement");
    }
    Ok(
        json!({"entity":row["entity"],"informationType":row["information_type"],"category":row["category"],"period":row["period"],"statement":row["statement"],"forecastMeasurement":if measurement.as_object().unwrap().is_empty() {Value::Null} else {measurement}}),
    )
}

pub fn records_digest_input(rows: &[Value]) -> Result<String> {
    let mut rows = rows.to_vec();
    rows.sort_by_key(|row| row["sort_order"].as_i64().unwrap_or(0));
    let records = rows
        .iter()
        .map(|row| {
            let mut record = row_to_information(row)?;
            for key in ["information_id", "doc_id", "entity_key", "sort_order"] {
                record[key] = row[key].clone();
            }
            Ok(record)
        })
        .collect::<Result<Vec<Value>>>()?;
    Ok(canonical_json(&json!(records)))
}

pub fn sha256_text(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
pub fn contract_matches(current: &Value, contract: &Value) -> bool {
    current.is_object()
        && contract.as_object().is_some_and(|fields| {
            fields
                .iter()
                .all(|(key, value)| current.get(key) == Some(value))
        })
}

pub fn extraction_is_current(
    state: &Value,
    row: &Value,
    contracts: &[Value],
    allow_review: bool,
) -> bool {
    let current = &state["current"];
    current.is_object()
        && state["status"] == "complete"
        && current["storageVersion"] == INFORMATION_STORAGE_VERSION
        && current["provenanceStatus"] == "verified"
        && contracts
            .iter()
            .any(|contract| contract_matches(current, contract))
        && current["inputFingerprint"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
        && current["recordsDigest"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
        && row["content_sha256"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
        && current["contentSha256"] == row["content_sha256"]
        && current["title"] == row["title"]
        && current["publishedAt"] == row["published_at"]
        && (allow_review
            || (current["outcome"] == "extracted" && current["categoryCandidateCount"] == 0))
}
pub fn extraction_outcome(records: &[Value], candidates: Option<&[Value]>) -> &'static str {
    if candidates.is_none_or(|candidates| !candidates.is_empty()) {
        "needs_review"
    } else if records.is_empty() {
        "no_information"
    } else {
        "extracted"
    }
}
pub fn sql_text(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}
fn safe_alias(alias: &str) -> Result<&str> {
    if !regex::Regex::new(r"^[a-z][a-z0-9_]*$")
        .unwrap()
        .is_match(alias)
    {
        bail!("invalid SQL alias");
    }
    Ok(alias)
}

pub fn current_extraction_sql(
    alias: &str,
    contracts: &[Value],
    allow_review: bool,
) -> Result<String> {
    let d = safe_alias(alias)?;
    let field = |key: &str| {
        format!("json_extract({d}.metadata_json,'$.informationExtraction.current.{key}')")
    };
    let checks = contracts
        .iter()
        .map(|contract| {
            let entries = contract
                .as_object()
                .context("invalid extraction contract")?;
            Ok(format!(
                "({})",
                entries
                    .iter()
                    .map(|(key, value)| format!(
                        "{}={}",
                        field(key),
                        sql_text(value.as_str().unwrap_or(""))
                    ))
                    .collect::<Vec<_>>()
                    .join(" AND ")
            ))
        })
        .collect::<Result<Vec<_>>>()?
        .join(" OR ");
    if checks.is_empty() {
        bail!("no accepted extraction contract");
    }
    Ok(format!("coalesce((json_extract({d}.metadata_json,'$.informationExtraction.status')='complete'
        AND {storage}={storage_value} AND {provenance}='verified' AND ({checks})
        AND length({fingerprint})>0 AND length({digest})>0
        AND {title}={d}.title AND {published} IS {d}.published_at
        AND EXISTS (SELECT 1 FROM knowledge_doc_content_refs ic WHERE ic.doc_id={d}.doc_id AND ic.content_sha256={sha} AND ic.content_key IS NOT NULL)
        AND {count}=(SELECT count(*) FROM knowledge_information_records irc WHERE irc.doc_id={d}.doc_id)
        {review}),0)",storage=field("storageVersion"),storage_value=sql_text(INFORMATION_STORAGE_VERSION),provenance=field("provenanceStatus"),fingerprint=field("inputFingerprint"),digest=field("recordsDigest"),title=field("title"),published=field("publishedAt"),sha=field("contentSha256"),count=field("recordCount"),review=if allow_review {String::new()} else {format!("AND {}='extracted' AND {}=0",field("outcome"),field("categoryCandidateCount"))}))
}

pub fn information_rows_json_sql(alias: &str) -> Result<String> {
    let d = safe_alias(alias)?;
    Ok(format!(
        "(SELECT coalesce(json_group_array(json_object('information_id',r.information_id,'doc_id',r.doc_id,'entity',r.entity,'entity_key',r.entity_key,'information_type',r.information_type,'category',r.category,'period',r.period,'statement',r.statement,'forecast_measurement_json',r.forecast_measurement_json,'sort_order',r.sort_order,'created_at',r.created_at)), '[]') FROM (SELECT * FROM knowledge_information_records WHERE doc_id={d}.doc_id ORDER BY sort_order) r)"
    ))
}

pub fn tags_for_information_rows(rows: &[Value]) -> Vec<Value> {
    let mut categories = Vec::new();
    let mut companies = Vec::new();
    for row in rows {
        if let Some(category) = row["category"].as_str()
            && !categories.contains(&category)
        {
            categories.push(category);
        }
        if let Some(company) = row["entity_key"].as_str()
            && company.starts_with("company:")
            && !companies.contains(&company)
        {
            companies.push(company);
        }
    }
    categories.into_iter().enumerate().map(|(index,category)|json!({"tag":format!("category:{category}"),"weight":(100_i64-index as i64*10).max(1)}))
        .chain(companies.into_iter().map(|company|json!({"tag":company,"weight":100}))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_numbers_and_integrity_are_javascript_compatible() {
        assert_eq!(
            canonical_json(&json!({"z":100.0,"a":[0.0000001,1e20,-0.0]})),
            r#"{"a":[1e-7,100000000000000000000,0],"z":100}"#
        );
        assert_eq!(
            sha256_text("hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        assert!(
            current_extraction_sql(
                "d; DROP TABLE knowledge_docs",
                &extraction_contracts().unwrap(),
                true
            )
            .is_err()
        );
        assert!(information_rows_json_sql("d.a").is_err());
        assert!(extraction_contracts().unwrap().len() > 1);
        assert!(row_to_information(&json!({"forecast_measurement_json":"[]"})).is_err());
    }

    #[test]
    fn historical_node_digest_golden_remains_valid() {
        // Generated independently by the existing TS recordsDigestInput +
        // sha256Text, including Number(100.0) and JS's 1e20 formatting.
        let row = json!({"information_id":"i_verified","doc_id":"verified","entity":"招商银行","entity_key":"company:600036.SH","information_type":"fact","category":"net_profit","period":"2026-Q3","statement":"fixture factual statement","forecast_measurement_json":r#"{"value":100.0,"scale":1e20}"#,"sort_order":0,"created_at":1});
        assert_eq!(
            sha256_text(&records_digest_input(&[row]).unwrap()),
            "0303a21b6d565e4e61f44a73c9b1b1382d00fd63620b063367a6d20c24d78b63"
        );
    }
}
