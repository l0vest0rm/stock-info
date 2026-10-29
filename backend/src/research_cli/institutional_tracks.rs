use super::{api, read_config, string, write_json};
use crate::{AppState, http::number};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

type Assignment = (String, String, String);
struct Index {
    version: i64,
    industries: BTreeMap<String, Assignment>,
    companies: BTreeMap<String, Assignment>,
}
fn entries<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value[key].as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn assignment(value: &Value, pairs: &BTreeSet<(String, String)>) -> Result<Assignment> {
    let pair = (
        string(value, "primaryTrack").to_owned(),
        string(value, "secondaryTrack").to_owned(),
    );
    if !pairs.contains(&pair) {
        bail!("invalid track pair {}/{}", pair.0, pair.1);
    }
    Ok((pair.0, pair.1, string(value, "reason").to_owned()))
}
fn add_company(
    map: &mut BTreeMap<String, Assignment>,
    code: &str,
    value: &Assignment,
) -> Result<()> {
    let code = code.trim();
    if code.is_empty() {
        bail!("institutional taxonomy contains an empty company code");
    }
    if map.insert(code.into(), value.clone()).is_some() {
        bail!("{code}: duplicate company assignment");
    }
    Ok(())
}
fn index(taxonomy: &Value) -> Result<Index> {
    if !taxonomy.is_object() {
        bail!("institutional taxonomy must be an object");
    }
    let version = taxonomy["version"]
        .as_i64()
        .filter(|n| *n >= 1)
        .context("taxonomy version must be a positive integer")?;
    let mut pairs = BTreeSet::new();
    let mut owners = BTreeMap::new();
    for primary in entries(taxonomy, "primaryTracks") {
        let name = string(primary, "name");
        if name.is_empty() {
            bail!("empty primary track");
        }
        for secondary in entries(primary, "secondaryTracks") {
            let secondary = secondary.as_str().unwrap_or("").trim();
            if secondary.is_empty() {
                bail!("empty secondary track");
            }
            if let Some(old) = owners.insert(secondary.to_owned(), name.to_owned())
                && old != name
            {
                bail!("secondary track belongs to multiple primary tracks");
            }
            pairs.insert((name.to_owned(), secondary.to_owned()));
        }
    }
    if pairs.is_empty() {
        bail!("taxonomy contains no track pairs");
    }
    let mut industries = BTreeMap::new();
    let mut companies = BTreeMap::new();
    for rule in entries(taxonomy, "industryAssignments") {
        let a = assignment(rule, &pairs)?;
        for industry in entries(rule, "industries") {
            let industry = industry.as_str().unwrap_or("").trim();
            if industry.is_empty() {
                bail!("empty exact industry assignment");
            }
            if industries.insert(industry.into(), a.clone()).is_some() {
                bail!("duplicate exact industry assignment: {industry}");
            }
        }
    }
    for group in entries(taxonomy, "companyAssignmentGroups") {
        let a = assignment(group, &pairs)?;
        if a.2.is_empty() {
            bail!("company assignment requires reason");
        }
        for code in entries(group, "codes") {
            add_company(&mut companies, code.as_str().unwrap_or(""), &a)?;
        }
    }
    if let Some(values) = taxonomy["companyAssignments"].as_object() {
        for (code, value) in values {
            let a = assignment(value, &pairs)?;
            if a.2.is_empty() {
                bail!("company assignment requires reason");
            }
            add_company(&mut companies, code, &a)?;
        }
    }
    Ok(Index {
        version,
        industries,
        companies,
    })
}
pub fn classify(snapshot: &Value, taxonomy: &Value) -> Result<Value> {
    let index = index(taxonomy)?;
    let rows = snapshot["rows"]
        .as_array()
        .context("institutional snapshot rows must be an array")?;
    let mut output = snapshot.clone();
    let mut mapped = Vec::new();
    for row in rows {
        let code = string(row, "code");
        let name = string(row, "name");
        let industry = string(row, "industry");
        if code.is_empty() || name.is_empty() || industry.is_empty() {
            bail!("institutional row requires code/name/industry");
        }
        let company = index.companies.get(code);
        let a = company
            .or_else(|| index.industries.get(industry))
            .with_context(|| {
                format!("{code} {name}: unmapped exact Eastmoney industry {industry}")
            })?;
        let mut row = row.clone();
        row["primaryTrack"] = json!(a.0);
        row["secondaryTrack"] = json!(a.1);
        if company.is_some() {
            row["classificationBasis"] = json!("company");
            row["classificationLabel"] = json!(a.2);
            row["classificationNote"] = json!(format!(
                "公司级主营校正：{}。东财主题概念不参与主营赛道判定。",
                a.2
            ));
        } else {
            row["classificationBasis"] = json!("industry");
            row["classificationLabel"] = json!(format!("东财行业：{industry}"));
            row["classificationNote"] = json!(format!(
                "按东财行业“{industry}”映射主营赛道；东财主题概念不参与主营赛道判定。"
            ));
        }
        mapped.push(row);
    }
    output["classificationVersion"] = json!(index.version);
    output["rows"] = json!(mapped);
    Ok(output)
}
pub async fn run(state: &AppState, options: &Value) -> Result<Value> {
    let ranking = api(
        state,
        "/api/companies/filter",
        &[
            ("st".into(), "ALLCORP_NUM".into()),
            ("sr".into(), "-1".into()),
            ("ps".into(), "300".into()),
            ("p".into(), "1".into()),
            (
                "sty".into(),
                "SECUCODE,SECURITY_NAME_ABBR,ALLCORP_NUM,MAX_TRADE_DATE".into(),
            ),
        ],
    )
    .await?;
    let ranking = ranking["data"].as_array().context("ranking has no rows")?;
    if ranking.len() != 300 {
        bail!("expected 300 ranking rows, received {}", ranking.len());
    }
    let mut unique = BTreeSet::new();
    let mut previous = f64::INFINITY;
    for row in ranking {
        if !unique.insert(string(row, "SECUCODE")) {
            bail!("ranking contains duplicate codes");
        }
        let n = number(&row["ALLCORP_NUM"]).context("invalid institution count")?;
        if n > previous {
            bail!("ranking not descending");
        }
        previous = n;
    }
    let mut industries = BTreeMap::new();
    let first = api(
        state,
        "/api/companies/change",
        &[("pz".into(), "100".into()), ("pn".into(), "1".into())],
    )
    .await?;
    let page_count = (number(&first["total"]).unwrap_or(0.0) / 100.0).ceil() as usize;
    if page_count > 1000 {
        bail!("invalid industry page count");
    }
    for row in entries(&first, "diff") {
        industries.insert(
            string(row, "f12").to_owned(),
            string(row, "f100").to_owned(),
        );
    }
    for page in 2..=page_count {
        let data = api(
            state,
            "/api/companies/change",
            &[("pz".into(), "100".into()), ("pn".into(), page.to_string())],
        )
        .await?;
        for row in entries(&data, "diff") {
            industries.insert(
                string(row, "f12").to_owned(),
                string(row, "f100").to_owned(),
            );
        }
    }
    let concepts = api(
        state,
        "/api/companies/filter",
        &[
            ("st".into(), "ALLCORP_NUM".into()),
            ("sr".into(), "-1".into()),
            ("ps".into(), "1000".into()),
            ("p".into(), "1".into()),
            ("sty".into(), "SECUCODE,INDUSTRY,CONCEPT".into()),
        ],
    )
    .await?;
    let concepts = entries(&concepts, "data")
        .iter()
        .map(|row| (string(row, "SECUCODE"), row))
        .collect::<BTreeMap<_, _>>();
    let rows=ranking.iter().enumerate().map(|(i,row)|{
        let code=string(row,"SECUCODE");let concept=concepts.get(code).copied().unwrap_or(&Value::Null);
        let industry=industries.get(code.split('.').next().unwrap_or(code)).filter(|s|!s.is_empty()).map(String::as_str).unwrap_or_else(||if string(concept,"INDUSTRY").is_empty(){"未分类"}else{string(concept,"INDUSTRY")});
        json!({"rank":i+1,"code":code,"name":string(row,"SECURITY_NAME_ABBR"),"institutionCount":number(&row["ALLCORP_NUM"]).unwrap_or(0.0),"industry":industry,"concepts":concept["CONCEPT"].as_array().cloned().unwrap_or_default()})
    }).collect::<Vec<_>>();
    let snapshot = classify(
        &json!({"generatedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"dataDate":ranking[0]["MAX_TRADE_DATE"],"rankingField":"ALLCORP_NUM","source":"Eastmoney via stock-info","rows":rows}),
        &read_config(state, "web/src/config/institutional-track-taxonomy.json")?,
    )?;
    let output = state.root.join(if string(options, "output").is_empty() {
        "web/src/config/institutional-track-snapshot.json"
    } else {
        string(options, "output")
    });
    write_json(&output, &snapshot)?;
    Ok(
        json!({"output":output,"rows":snapshot["rows"].as_array().map(Vec::len),"dataDate":snapshot["dataDate"]}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    fn taxonomy() -> Value {
        json!({"version":1,"primaryTracks":[{"name":"金融","secondaryTracks":["银行","保险"]}],"industryAssignments":[{"primaryTrack":"金融","secondaryTrack":"银行","industries":["银行"]}],"companyAssignments":{"000001.SZ":{"primaryTrack":"金融","secondaryTrack":"保险","reason":"核验主营"}}})
    }
    #[test]
    fn original_javascript_classification_golden() {
        let fixture: Value =
            serde_json::from_str(include_str!("fixtures/institutional-classification.json"))
                .unwrap();
        let taxonomy: Value = serde_json::from_str(include_str!(
            "../../../web/src/config/institutional-track-taxonomy.json"
        ))
        .unwrap();
        assert_eq!(
            classify(&fixture["input"], &taxonomy).unwrap(),
            fixture["expected"]
        );
    }
    #[test]
    fn company_override_and_exact_industry_are_not_concept_guesses() {
        let out=classify(&json!({"rows":[{"code":"000001.SZ","name":"甲","industry":"银行","concepts":["芯片"]},{"code":"600036.SH","name":"乙","industry":"银行"}]}),&taxonomy()).unwrap();
        assert_eq!(out["rows"][0]["secondaryTrack"], "保险");
        assert_eq!(out["rows"][0]["classificationBasis"], "company");
        assert_eq!(out["rows"][1]["classificationLabel"], "东财行业：银行");
        assert!(
            classify(
                &json!({"rows":[{"code":"1","name":"甲","industry":"未知","concepts":["银行"]}]}),
                &taxonomy()
            )
            .is_err()
        );
    }
    #[test]
    fn duplicates_invalid_pairs_and_owner_conflicts_reject() {
        let mut t = taxonomy();
        t["industryAssignments"][0]["industries"] = json!(["银行", "银行"]);
        assert!(index(&t).is_err());
        let mut t = taxonomy();
        t["companyAssignmentGroups"] = json!([{"primaryTrack":"金融","secondaryTrack":"银行","reason":"重叠","codes":["000001.SZ"]}]);
        assert!(index(&t).is_err());
        let mut t = taxonomy();
        t["industryAssignments"][0]["secondaryTrack"] = json!("无效");
        assert!(index(&t).is_err());
    }
}
