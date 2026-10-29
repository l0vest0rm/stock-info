use super::{text, write_json};
use crate::AppState;
use anyhow::{Result, bail};
use futures_util::{StreamExt, stream};
use reqwest::{Method, Url, header::HeaderMap};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
};

fn nonempty(v: &Value) -> Option<String> {
    v.as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}
fn values(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}
fn strings(v: &Value) -> Vec<String> {
    let mut seen = BTreeSet::new();
    values(v)
        .iter()
        .filter_map(nonempty)
        .filter(|s| seen.insert(s.clone()))
        .collect()
}
fn normalized(entry: &Value) -> Option<Value> {
    let code = text(entry, "code").to_uppercase();
    if code.is_empty() {
        return None;
    }
    let industry = nonempty(
        entry
            .get("industry")
            .filter(|v| !v.is_null())
            .unwrap_or(&entry["em2016"]),
    );
    let levels: Vec<String> = if entry["industryLevels"].is_array() {
        values(&entry["industryLevels"])
            .iter()
            .filter_map(nonempty)
            .collect()
    } else {
        industry
            .as_deref()
            .unwrap_or("")
            .split('-')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect()
    };
    let availability = nonempty(&entry["availability"])
        .or_else(|| nonempty(&entry["status"]))
        .unwrap_or_else(|| {
            if industry.is_some() {
                "available"
            } else {
                "unavailable"
            }
            .into()
        });
    let mut profile = json!({"code":code,"availability":availability,"industry":industry,"industryLevels":levels,"mainBusiness":nonempty(&entry["mainBusiness"]),"products":strings(&entry["products"])});
    for key in ["name", "sourceUrl", "updatedAt"] {
        if let Some(value) = nonempty(&entry[key]) {
            profile[key] = json!(value);
        }
    }
    Some(profile)
}
fn codes(input: &Value) -> Vec<String> {
    if input.is_array() {
        return strings(input)
            .into_iter()
            .map(|s| s.to_uppercase())
            .collect();
    }
    if input["codes"].is_array() {
        return strings(&input["codes"])
            .into_iter()
            .map(|s| s.to_uppercase())
            .collect();
    }
    values(&input["rows"])
        .iter()
        .filter_map(|r| nonempty(&r["code"]).or_else(|| nonempty(&r["SECUCODE"])))
        .map(|s| s.to_uppercase())
        .collect()
}
fn source(code: &str) -> Result<Url> {
    let mut url = Url::parse("https://datacenter.eastmoney.com/securities/api/data/v1/get")?;
    url.query_pairs_mut().extend_pairs([
        ("reportName", "RPT_F10_ORG_BASICINFO"),
        (
            "columns",
            "SECUCODE,SECURITY_NAME_ABBR,EM2016,MAIN_BUSINESS,MAXPROFIT_PRODUCT,PRODUCT_NAME",
        ),
        ("quoteColumns", ""),
        ("filter", &format!("(SECUCODE=\"{code}\")")),
        ("pageNumber", "1"),
        ("pageSize", "1"),
        ("sortTypes", ""),
        ("sortColumns", ""),
        ("source", "HSF10"),
        ("client", "PC"),
    ]);
    Ok(url)
}
fn map_profile(code: &str, name: &str, source: &str, row: &Value) -> Value {
    let industry = nonempty(&row["EM2016"]);
    let mut profile = json!({"code":code,"availability":if industry.is_some(){"available"}else{"unavailable"},"industry":industry,"industryLevels":industry.as_deref().unwrap_or("").split('-').map(str::trim).filter(|s|!s.is_empty()).collect::<Vec<_>>(),"mainBusiness":nonempty(&row["MAIN_BUSINESS"]),"products":strings(&json!([row["MAXPROFIT_PRODUCT"],row["PRODUCT_NAME"]])),"sourceUrl":source,"updatedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true)});
    if let Some(name) = nonempty(&row["SECURITY_NAME_ABBR"]).or_else(|| {
        if name.is_empty() {
            None
        } else {
            Some(name.to_owned())
        }
    }) {
        profile["name"] = json!(name);
    }
    profile
}
async fn fetch(state: &AppState, code: String, name: String) -> Result<(String, Value)> {
    let url = source(&code)?;
    let mut headers = HeaderMap::new();
    headers.insert(
        "referer",
        "https://emweb.securities.eastmoney.com/".parse()?,
    );
    let result = state
        .http
        .text(url.as_str(), Method::GET, headers, None)
        .await
        .and_then(|body| Ok(serde_json::from_str::<Value>(&body)?));
    let mut profile = map_profile(
        &code,
        &name,
        url.as_str(),
        result
            .as_ref()
            .ok()
            .map(|v| &v["result"]["data"][0])
            .unwrap_or(&Value::Null),
    );
    if let Err(error) = result {
        profile["error"] = json!(error.to_string());
    }
    Ok((code, profile))
}
pub async fn run(state: &AppState, options: &Value) -> Result<Value> {
    let input_name = if text(options, "input").is_empty() {
        "web/src/config/institutional-track-snapshot.json"
    } else {
        text(options, "input")
    };
    let input_path = state.root.join(input_name);
    let output_name = "config/generated/eastmoney-company-em2016-profiles.json";
    let output_path = state.root.join(output_name);
    let input: Value = fs::read(&input_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null);
    let existing: Value = fs::read(&output_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null);
    let mut profiles: BTreeMap<String, Value> = values(&existing["profiles"])
        .iter()
        .filter_map(normalized)
        .map(|v| (text(&v, "code").to_owned(), v))
        .collect();
    let mut targets = codes(&input);
    targets.extend(
        text(options, "codes")
            .split(|c: char| c.is_whitespace() || c == ',')
            .filter(|s| !s.is_empty())
            .map(str::to_uppercase),
    );
    let mut seen = BTreeSet::new();
    targets.retain(|s| seen.insert(s.clone()));
    if targets.is_empty() {
        bail!("no security codes resolved; pass --codes or provide an input json with rows[].code");
    }
    let names: BTreeMap<String, String> = values(&input["rows"])
        .iter()
        .filter_map(|row| {
            let code = nonempty(&row["code"]).or_else(|| nonempty(&row["SECUCODE"]))?;
            let name = nonempty(&row["name"]).or_else(|| nonempty(&row["SECURITY_NAME_ABBR"]))?;
            Some((code.to_uppercase(), name))
        })
        .collect();
    let pending = targets
        .into_iter()
        .filter(|code| {
            options["refreshExisting"] == true
                || !profiles.get(code).is_some_and(|entry| {
                    entry["availability"] == "available"
                        && nonempty(&entry["industry"]).is_some()
                        && entry["industryLevels"]
                            .as_array()
                            .is_some_and(|l| l.len() == 3)
                })
        })
        .collect::<Vec<_>>();
    let limit = options["concurrency"].as_u64().unwrap_or(4).max(1) as usize;
    let fetched = pending.len();
    let mut results = stream::iter(pending.into_iter().map(|code| {
        let name = names.get(&code).cloned().unwrap_or_default();
        fetch(state, code, name)
    }))
    .buffer_unordered(limit);
    while let Some(result) = results.next().await {
        let (code, profile) = result?;
        profiles.insert(code, profile);
    }
    let profiles = profiles.into_values().collect::<Vec<_>>();
    let available = profiles
        .iter()
        .filter(|p| p["availability"] == "available" && nonempty(&p["industry"]).is_some())
        .count();
    let input_relative = input_path
        .strip_prefix(&state.root)
        .unwrap_or(&input_path)
        .to_string_lossy();
    let output = json!({"schemaVersion":"eastmoney-company-em2016-profiles.v1","taxonomy":"eastmoney-em2016.v1","generatedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"source":{"endpoint":"https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_ORG_BASICINFO","field":"EM2016","inputPath":input_relative},"coverage":{"total":profiles.len(),"available":available,"unavailable":profiles.len()-available},"profiles":profiles});
    write_json(&output_path, &output)?;
    Ok(
        json!({"output":output_name,"input":input_relative,"totalProfiles":output["profiles"].as_array().map(Vec::len),"fetched":fetched,"available":available}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn existing_profile_normalization_keeps_taxonomy_and_optional_fields() {
        let v=normalized(&json!({"code":"600036.sh","em2016":" 金融-银行-股份制银行 ","products":["存款","存款","贷款"],"name":" 招商银行 "})).unwrap();
        assert_eq!(v["code"], "600036.SH");
        assert_eq!(v["industryLevels"], json!(["金融", "银行", "股份制银行"]));
        assert_eq!(v["products"], json!(["存款", "贷款"]));
        assert!(v.get("sourceUrl").is_none());
        let repeated = normalized(
            &json!({"code":"x.US","industry":null,"em2016":"a-a-a","industryLevels":["a","a","a"]}),
        )
        .unwrap();
        assert_eq!(repeated["industry"], "a-a-a");
        assert_eq!(repeated["industryLevels"], json!(["a", "a", "a"]));
        assert_eq!(
            codes(&json!({"rows":[{"SECUCODE":"AAPL.us"}]})),
            vec!["AAPL.US"]
        );
    }
    #[test]
    fn provider_mapping_never_fabricates_industry() {
        let v = map_profile(
            "600036.SH",
            "招商银行",
            "https://provider.example/",
            &Value::Null,
        );
        assert_eq!(v["availability"], "unavailable");
        assert_eq!(v["industry"], Value::Null);
        assert_eq!(v["products"], json!([]));
        assert_eq!(v["name"], "招商银行");
    }
}
