//! Daily Eastmoney valuation observations, not a stock K-line provider.
//! Dates/ratios and unadjusted closing-price inputs only; no price fallback or PIT claim.
#[cfg(feature = "sqlite-cache")]
pub mod cached;

use crate::{Runtime, codes, http::parse_json_or_jsonp};
use anyhow::{Result, bail};
use chrono::NaiveDate;
use reqwest::{Url, header::HeaderMap};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug)]
pub enum Metric {
    PeTtm,
    Pb,
}
impl Metric {
    pub fn field(self) -> &'static str {
        match self {
            Self::PeTtm => "PE_TTM",
            Self::Pb => "PB_MRQ",
        }
    }
}

fn identity(code: &str) -> Result<()> {
    if codes::normalize(code) != code
        || code.len() != 9
        || !code.as_bytes()[..6].iter().all(u8::is_ascii_digit)
        || !((code.ends_with(".SH") && (code.starts_with("60") || code.starts_with("68")))
            || (code.ends_with(".SZ") && (code.starts_with("00") || code.starts_with("30"))))
    {
        bail!("daily valuation requires qualified SH/SZ A-share code");
    }
    Ok(())
}
fn date(row: &Value, code: &str, from: NaiveDate, to: NaiveDate) -> Result<NaiveDate> {
    if row["SECUCODE"].as_str() != Some(code) {
        bail!("valuation identity mismatch");
    }
    let date = row["TRADE_DATE"]
        .as_str()
        .and_then(|s| s.get(..10))
        .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
        .ok_or_else(|| anyhow::anyhow!("invalid valuation date"))?;
    if date < from || date > to {
        bail!("valuation date outside request");
    }
    Ok(date)
}
fn numeric(row: &Value, field: &str) -> Result<Option<f64>> {
    match &row[field] {
        Value::Null => Ok(None),
        Value::Number(n) => Ok(n.as_f64().filter(|v| v.is_finite())),
        _ => bail!("invalid valuation number"),
    }
}
/// Pure ascending series. Missing/non-positive ratios are gaps, extreme positives stay intact.
pub fn series(
    rows: &[Value],
    code: &str,
    metric: Metric,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<Vec<Value>> {
    identity(code)?;
    let mut points = BTreeMap::new();
    for row in rows {
        let date = date(row, code, from, to)?;
        let raw = numeric(row, metric.field())?;
        let value = raw.filter(|v| *v > 0.0);
        let status = if value.is_some() {
            "available"
        } else if raw.is_some() {
            "non_positive"
        } else {
            "missing"
        };
        if points
            .insert(
                date,
                json!({"date":date.to_string(),"value":value,"status":status,"reportDate":null}),
            )
            .is_some()
        {
            bail!("duplicate valuation date");
        }
    }
    Ok(points.into_values().collect())
}
async fn daily_rows(
    runtime: &impl Runtime,
    code: &str,
    field: &str,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<Vec<Value>> {
    identity(code)?;
    if from > to {
        return Ok(vec![]);
    }
    let start = Instant::now();
    let mut rows = vec![];
    let mut total = None;
    let mut expected_pages = None;
    for page in 1..=20 {
        if start.elapsed() > Duration::from_secs(35) {
            bail!("valuation request budget exceeded");
        }
        let mut url = Url::parse("https://datacenter-web.eastmoney.com/api/data/v1/get")?;
        url.query_pairs_mut().extend_pairs([
            ("reportName", "RPT_VALUEANALYSIS_DET".to_string()),
            ("columns", format!("SECUCODE,TRADE_DATE,{field}")),
            (
                "filter",
                format!("(SECUCODE=\"{code}\")(TRADE_DATE>='{from}')(TRADE_DATE<='{to}')"),
            ),
            ("sortColumns", "TRADE_DATE".into()),
            ("sortTypes", "-1".into()),
            ("pageSize", "500".into()),
            ("pageNumber", page.to_string()),
        ]);
        let body = parse_json_or_jsonp(&runtime.get_text(url.as_str(), HeaderMap::new()).await?)?;
        if body["success"] != true {
            bail!("valuation provider rejected request");
        }
        let result = &body["result"];
        let count = result["count"]
            .as_u64()
            .ok_or_else(|| anyhow::anyhow!("valuation count missing"))?;
        let pages = result["pages"]
            .as_u64()
            .ok_or_else(|| anyhow::anyhow!("valuation pages missing"))?;
        if count > 10000
            || pages > 20
            || total.is_some_and(|n| n != count)
            || expected_pages.is_some_and(|n| n != pages)
        {
            bail!("valuation pagination invalid or changed");
        }
        total = Some(count);
        expected_pages = Some(pages);
        let data = result["data"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("valuation rows missing"))?;
        if data.len() > 500 || (data.is_empty() && count > 0) {
            bail!("valuation page incomplete");
        }
        rows.extend(data.iter().cloned());
        if page >= pages {
            if rows.len() as u64 != count {
                bail!("valuation history incomplete");
            }
            return Ok(rows);
        }
    }
    bail!("valuation page limit exceeded")
}
pub async fn history(
    runtime: &impl Runtime,
    code: &str,
    metric: Metric,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<Vec<Value>> {
    let rows = daily_rows(runtime, code, metric.field(), from, to).await?;
    series(&rows, code, metric, from, to)
}
/// Explicit price inputs for dividend arithmetic, from daily valuation observations.
/// No OHLC, stock K-line acquisition, adjustment calculation, cookie or account runtime.
pub async fn closing_prices(
    runtime: &impl Runtime,
    code: &str,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<Vec<Value>> {
    let rows = daily_rows(runtime, code, "CLOSE_PRICE", from, to).await?;
    let mut points = BTreeMap::new();
    for row in rows {
        let date = date(&row, code, from, to)?;
        let close = numeric(&row, "CLOSE_PRICE")?.filter(|v| *v > 0.0);
        if points
            .insert(date, json!({"date":date.to_string(),"close":close}))
            .is_some()
        {
            bail!("duplicate closing date");
        }
    }
    Ok(points.into_values().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ratios_preserve_gaps_extremes_and_independent_fields() {
        let from = "2026-01-01".parse().unwrap();
        let to = "2026-11-20".parse().unwrap();
        let rows = [
            json!({"SECUCODE":"600519.SH","TRADE_DATE":"2026-01-05","PE_TTM":10000.0,"PB_MRQ":-1.0}),
            json!({"SECUCODE":"600519.SH","TRADE_DATE":"2026-01-04","PE_TTM":null,"PB_MRQ":2.0}),
            json!({"SECUCODE":"600519.SH","TRADE_DATE":"2026-01-03","PE_TTM":-2.0,"PB_MRQ":0.0}),
        ];
        let pe = series(&rows, "600519.SH", Metric::PeTtm, from, to).unwrap();
        assert_eq!(pe[0]["status"], "non_positive");
        assert_eq!(pe[1]["status"], "missing");
        assert_eq!(pe[2]["value"], 10000.0);
        let pb = series(&rows, "600519.SH", Metric::Pb, from, to).unwrap();
        assert_eq!(pb[0]["value"], Value::Null);
        assert_eq!(pb[1]["value"], 2.0);
        assert_eq!(pb[2]["status"], "non_positive");
        for patch in [
            json!({"SECUCODE":"000001.SZ"}),
            json!({"TRADE_DATE":"2026-02-30"}),
            json!({"TRADE_DATE":"2027-01-01"}),
            json!({"PE_TTM":"bad"}),
        ] {
            let mut bad = rows[0].clone();
            for (k, v) in patch.as_object().unwrap() {
                bad[k] = v.clone();
            }
            assert!(series(&[bad], "600519.SH", Metric::PeTtm, from, to).is_err());
        }
        assert!(
            series(
                &[rows[0].clone(), rows[0].clone()],
                "600519.SH",
                Metric::PeTtm,
                from,
                to
            )
            .is_err()
        );
        for code in ["600519", "510050.SH", "MU.US", "茅台.SH"] {
            assert!(identity(code).is_err());
        }
    }
}
