//! Native fund report artifact renderers. Generated browser sorting is static
//! frontend JavaScript; no JavaScript is executed by the Rust backend.
use serde_json::Value;

fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => value.clone(),
        Value::Number(value) => value
            .as_f64()
            .map(|n| ryu_js::Buffer::new().format(n).to_string())
            .unwrap_or_default(),
        Value::Bool(value) => value.to_string(),
        Value::Array(values) => values.iter().map(text).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}
fn html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
fn fixed(value: &Value) -> String {
    value
        .as_f64()
        .filter(|v| v.is_finite())
        .map(|n| ryu_js::Buffer::new().format_to_fixed(n, 2).to_string())
        .unwrap_or_else(|| "-".into())
}
fn percent(value: &Value) -> String {
    if value.as_f64().is_some_and(f64::is_finite) {
        format!("{}%", fixed(value))
    } else {
        "-".into()
    }
}
fn fallback(value: &Value) -> String {
    let value = text(value);
    if value.is_empty() { "-".into() } else { value }
}
fn encode(value: &str, uri: bool) -> String {
    let mut out = String::new();
    for b in value.as_bytes() {
        if b.is_ascii_alphanumeric()
            || b"-_.!~*'()".contains(b)
            || (uri && b";,/?:@&=+$#".contains(b))
        {
            out.push(*b as char);
        } else {
            use std::fmt::Write;
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}
fn table(value: &Value) -> String {
    text(value).replace('|', "\\|").replace('\n', " ")
}

pub fn render_fund_index_markdown(input: &Value) -> String {
    let mut rows = array(&input["funds"]).iter().collect::<Vec<_>>();
    rows.sort_by(|a, b| {
        a["rank"]
            .as_f64()
            .unwrap_or(0.0)
            .total_cmp(&b["rank"].as_f64().unwrap_or(0.0))
            .then_with(|| text(&a["code"]).cmp(&text(&b["code"])))
    });
    let mut lines = vec![
        format!("# 基金季度分析索引（{}）", text(&input["quarter"])),
        String::new(),
        format!(
            "> 数据截至：{}；持仓报告期：{}；已生成报告：{} 只。",
            text(&input["asOf"]),
            text(&input["reportDate"]),
            rows.len()
        ),
        String::new(),
    ];
    let statistics = text(&input["holdingsStatisticsFilename"]);
    if !statistics.is_empty() {
        lines.push(format!(
            "[查看跨基金持仓统计](./{})",
            encode(&statistics, true)
        ));
        lines.push(String::new());
    }
    lines.push("| 近3月排名 | 近3月收益 | 近1月收益 | 近6月收益 | 基金名称 | 代码 | 份额类别 | 净值日期 | 季报发布日期 | 分析报告 |".into());
    lines.push("|---:|---:|---:|---:|---|---|---|---|---|---|".into());
    for fund in &rows {
        lines.push(format!(
            "| {} | {} | {} | {} | {} | {} | {} | {} | {} | [查看](./{}) |",
            text(&fund["rank"]),
            percent(&fund["threeMonthReturnPct"]),
            percent(&fund["oneMonthReturnPct"]),
            percent(&fund["sixMonthReturnPct"]),
            table(&fund["name"]),
            text(&fund["code"]),
            fallback(&fund["shareClass"]),
            fallback(&fund["navDate"]),
            fallback(&fund["reportPublishDate"]),
            encode(&text(&fund["outputFilename"]), true)
        ));
    }
    if rows.is_empty() {
        lines.push("| - | - | - | - | 暂无已生成报告 | - | - | - | - | - |".into());
    }
    lines.extend(
        [
            "",
            "## 口径",
            "",
            "- 排名和收益率来自本次运行的近三个月基金排名快照。",
            "- A/B/C 份额已按配置去重；排名保留所选份额在原始 Top 100 中的名次。",
            "- 列表只收录已经成功生成或此前已存在的单基金季度报告。",
            "",
        ]
        .map(str::to_string),
    );
    lines.join("\n")
}

#[derive(Clone)]
enum Source {
    Key(&'static str),
    Price,
    Performance(String),
    Forecast(i64, &'static str),
}
enum Format {
    Text,
    Count,
    Percent,
    Link,
    Price,
    Forecast(Option<&'static str>),
}
struct Column {
    label: String,
    unit: &'static str,
    numeric: bool,
    source: Source,
    format: Format,
}
impl Column {
    fn new(label: impl Into<String>, source: Source, format: Format, numeric: bool) -> Self {
        Self {
            label: label.into(),
            unit: "",
            numeric,
            source,
            format,
        }
    }
    fn value<'a>(&self, holding: &'a Value) -> &'a Value {
        match &self.source {
            Source::Key(key) => &holding[key],
            Source::Price => &holding["market"]["price"],
            Source::Performance(key) => &holding["market"]["performance"][key],
            Source::Forecast(year, key) => array(&holding["forecasts"])
                .iter()
                .find(|v| v["year"].as_i64() == Some(*year))
                .map(|v| &v[key])
                .unwrap_or(&Value::Null),
        }
    }
    fn render(&self, holding: &Value, base: &str) -> String {
        let value = self.value(holding);
        match self.format {
            Format::Text => html(&if value.is_null() {
                "-".into()
            } else {
                text(value)
            }),
            Format::Count => text(value),
            Format::Percent => percent(value),
            Format::Link => format!(
                "<a href=\"{}\" target=\"_blank\" rel=\"noreferrer\">{}</a>",
                html(&format!(
                    "{}/company.html?code={}",
                    base.trim_end_matches('/'),
                    encode(&text(&holding["code"]), false)
                )),
                html(&text(&holding["name"]))
            ),
            Format::Price => {
                if value.as_f64().is_some_and(f64::is_finite) {
                    format!(
                        "{}<small>{}</small>",
                        fixed(value),
                        html(&fallback(&holding["market"]["priceDate"]))
                    )
                } else {
                    "-".into()
                }
            }
            Format::Forecast(sample) => {
                if !value.as_f64().is_some_and(f64::is_finite) {
                    return "-".into();
                }
                let mut out = fixed(value);
                if let (Source::Forecast(year, _), Some(sample)) = (&self.source, sample)
                    && let Some(forecast) = array(&holding["forecasts"])
                        .iter()
                        .find(|v| v["year"].as_i64() == Some(*year))
                    && forecast[sample].as_f64().is_some_and(|n| n != 0.0)
                {
                    out.push_str(&format!("<small>n={}</small>", text(&forecast[sample])));
                }
                out
            }
        }
    }
}
pub fn render_fund_holdings_statistics_html(input: &Value) -> String {
    let holdings = array(&input["holdings"]);
    let base = text(&input["baseUrl"]);
    let mut columns = vec![
        Column::new("持有基金数", Source::Key("fundCount"), Format::Count, true),
        Column::new("标的", Source::Key("name"), Format::Link, false),
        Column::new("代码", Source::Key("code"), Format::Text, false),
        Column::new(
            "权重合计",
            Source::Key("totalWeightPct"),
            Format::Percent,
            true,
        ),
        Column::new(
            "平均权重",
            Source::Key("averageWeightPct"),
            Format::Percent,
            true,
        ),
        Column::new(
            "最高权重",
            Source::Key("maxWeightPct"),
            Format::Percent,
            true,
        ),
        Column::new("当前价", Source::Price, Format::Price, true),
    ];
    for period in array(&input["periods"]) {
        columns.push(Column::new(
            text(&period["label"]),
            Source::Performance(text(&period["key"])),
            Format::Percent,
            true,
        ));
    }
    for year in array(&input["forecastYears"])
        .iter()
        .filter_map(Value::as_i64)
    {
        for (label, key, sample, unit, pct) in [
            (
                "营收",
                "revenueYi",
                Some("revenueSampleCount"),
                "亿元",
                false,
            ),
            ("营收增速", "revenueGrowthPct", None, "", true),
            (
                "归母净利润",
                "netProfitYi",
                Some("netProfitSampleCount"),
                "亿元",
                false,
            ),
            ("净利润增速", "netProfitGrowthPct", None, "", true),
            (" PE", "pe", None, "", false),
        ] {
            let mut column = Column::new(
                format!("{year}E{label}"),
                Source::Forecast(year, key),
                if pct {
                    Format::Percent
                } else {
                    Format::Forecast(sample)
                },
                true,
            );
            column.unit = unit;
            columns.push(column);
        }
    }
    let header=columns.iter().enumerate().map(|(i,c)|format!("<th scope=\"col\" data-column=\"{i}\" data-type=\"{}\" tabindex=\"0\">{}{}<span class=\"sort-indicator\" aria-hidden=\"true\"></span></th>",if c.numeric{"number"}else{"text"},html(&c.label),if c.unit.is_empty(){String::new()}else{format!("<small>{}</small>",html(c.unit))})).collect::<String>();
    let mut rows = holdings
        .iter()
        .map(|h| {
            format!(
                "<tr>{}</tr>",
                columns
                    .iter()
                    .map(|c| format!(
                        "<td data-sort-value=\"{}\" class=\"{}\">{}</td>",
                        html(&text(c.value(h))),
                        if c.numeric { "number" } else { "text" },
                        c.render(h, &base)
                    ))
                    .collect::<String>()
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    if rows.is_empty() {
        rows = format!(
            "<tr><td colspan=\"{}\">暂无可用持仓</td></tr>",
            columns.len()
        );
    }
    let warnings = array(&input["warnings"]);
    let warnings = if warnings.is_empty() {
        String::new()
    } else {
        format!(
            "<section><h2>数据缺失</h2><ul>{}</ul></section>",
            warnings
                .iter()
                .map(|v| format!("<li>{}</li>", html(&text(v))))
                .collect::<String>()
        )
    };
    let replacements = [
        ("@@QUARTER@@", html(&text(&input["quarter"]))),
        ("@@AS_OF@@", html(&text(&input["asOf"]))),
        ("@@REPORT_DATE@@", html(&text(&input["reportDate"]))),
        ("@@FUNDS_ANALYZED@@", text(&input["fundsAnalyzed"])),
        ("@@HOLDINGS_COUNT@@", holdings.len().to_string()),
        ("@@HEADER@@", header),
        ("@@ROWS@@", rows),
        ("@@WARNINGS@@", warnings),
    ];
    let mut output = include_str!("holdings-template.html").to_string();
    for (key, value) in replacements {
        output = output.replace(key, &value);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn original_javascript_artifact_renderers_match_exactly() {
        let fixtures: Value = serde_json::from_str(include_str!("render-goldens.json")).unwrap();
        for fixture in array(&fixtures) {
            let actual = match fixture["kind"].as_str().unwrap() {
                "index" => render_fund_index_markdown(&fixture["input"]),
                "html" => render_fund_holdings_statistics_html(&fixture["input"]),
                _ => unreachable!(),
            };
            assert_eq!(actual, fixture["expected"].as_str().unwrap());
        }
    }
    #[test]
    fn escaping_and_uri_encoders_keep_original_distinction() {
        assert_eq!(encode("基金 #?.md", true), "%E5%9F%BA%E9%87%91%20#?.md");
        assert_eq!(encode("A B.US?x", false), "A%20B.US%3Fx");
        assert_eq!(html("<script>&\"'"), "&lt;script&gt;&amp;&quot;&#39;");
    }
}
