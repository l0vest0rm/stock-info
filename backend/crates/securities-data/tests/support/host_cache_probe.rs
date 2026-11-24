// Test-only support for Trade and stock-info's real Runtime implementations.
// Never loaded by production binaries. The driver supplies an isolated root
// and disallows the fake upstream itself on every expected warm read.
use anyhow::{Context, Result, ensure};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
};

fn probe_dir() -> Result<PathBuf> {
    ensure!(
        std::env::var("SECURITIES_TEST_HOST_PROBE").as_deref() == Ok("1"),
        "use the cross-host acceptance script"
    );
    let dir = PathBuf::from(
        std::env::var_os("SECURITIES_CACHE_ACCEPTANCE_DIR")
            .context("missing isolated probe root")?,
    );
    ensure!(
        dir.is_absolute() && dir.is_dir(),
        "expected existing absolute probe directory"
    );
    ensure!(
        std::env::var_os("SECURITIES_PUBLIC_CACHE_DB").map(PathBuf::from)
            == Some(dir.join("public.sqlite3")),
        "probe must never open the normal cache"
    );
    Ok(dir)
}

pub(super) fn fixture_response(url: &str) -> Option<Result<String>> {
    if std::env::var("SECURITIES_TEST_HOST_PROBE").as_deref() != Ok("1") {
        return None;
    }
    Some((|| {
        let dir = probe_dir()?;
        let prefix = match std::env::var("SECURITIES_PROBE_DATASET")?.as_str() {
            "reports" => "https://reportapi.eastmoney.com/report/list?",
            "statement" => "https://datacenter-web.eastmoney.com/securities/api/data/get?",
            _ => anyhow::bail!("unknown dataset"),
        };
        ensure!(url.starts_with(prefix), "unexpected upstream");
        // Record attempts before rejecting a prohibited loader: serving stale
        // data after an unexpected network attempt must not pass acceptance.
        writeln!(
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("calls"))?,
            "{}",
            env!("CARGO_PKG_NAME")
        )?;
        ensure!(
            std::env::var("SECURITIES_PROBE_LOAD").as_deref() == Ok("allowed"),
            "warm read attempted upstream"
        );
        Ok(fs::read_to_string(dir.join("fixture.json"))?)
    })())
}

async fn run_provider(runtime: &impl securities_data::Runtime) -> Result<()> {
    let expected = std::env::var("SECURITIES_PROBE_EXPECT")?;
    match std::env::var("SECURITIES_PROBE_DATASET")?.as_str() {
        "reports" => {
            let rows =
                securities_data::reports::sources::eastmoney_reports(runtime, "600519.SH", 1, 10)
                    .await?;
            ensure!(
                rows.len() == 1 && rows[0]["title"].as_str() == Some(expected.as_str()),
                "wrong report revision"
            );
        }
        "statement" => {
            // One annual statement page; exercising the primary split read/write
            // independently of composite financials, snapshots and derived indicators.
            let mut url = reqwest::Url::parse(
                "https://datacenter-web.eastmoney.com/securities/api/data/get",
            )?;
            url.query_pairs_mut().extend_pairs([
                ("type", "RPT_F10_FINANCE_GINCOME"),
                ("sty", "APP_F10_GINCOME"),
                (
                    "filter",
                    r#"(SECUCODE="600519.SH")(REPORT_DATE in ('2025-12-31'))"#,
                ),
                ("p", "1"),
                ("ps", ""),
                ("sr", "-1"),
                ("st", "REPORT_DATE"),
                ("source", "HSF10"),
                ("client", "PC"),
            ]);
            let response =
                securities_data::finance::providers::cn_statement_page(runtime, &url).await?;
            let rows = response["result"]["data"]
                .as_array()
                .context("missing statement rows")?;
            ensure!(
                rows.len() == 1
                    && rows[0]["SECUCODE"] == "600519.SH"
                    && rows[0]["REPORT_DATE"] == "2025-12-31"
                    && rows[0]["TOTAL_OPERATE_INCOME"].as_i64() == Some(expected.parse()?),
                "wrong statement revision"
            );
        }
        _ => anyhow::bail!("unknown dataset"),
    }
    Ok(())
}
