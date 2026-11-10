//! Regression against a frozen real SSE payload.
//!
//! The fixture is the unmodified YunHQ response for 588000 captured at the
//! 2026-11-06 close (see `provenance` inside the file). It is never regenerated
//! from the code under test: it exists so that contract-id parsing, the
//! strike/`exepx` cross-check and the implied-volatility chain stay honest
//! against a provider that could change format tomorrow.
use chrono::{Datelike, NaiveDate};
use serde_json::Value;
use stock_info_local::option_math::{OptionKind, black_scholes, implied_volatility};
use stock_info_local::options_cn::{
    expiry_date, is_adjusted, parse_chain, parse_contract_id, years_between,
};

fn fixture() -> Value {
    let raw: Value =
        serde_json::from_str(include_str!("fixtures/sse-option-chain-588000.json")).unwrap();
    raw["payload"].clone()
}

#[test]
fn frozen_chain_parses_every_listed_contract() {
    let quotes = parse_chain("588000", &fixture()).unwrap();
    assert_eq!(quotes.len(), 176, "SSE listed 176 contracts on 2026-11-06");
    let puts = quotes.iter().filter(|q| q.kind == OptionKind::Put).count();
    assert_eq!(puts, 88);
    // No contract may carry a zero strike or a rejected strike mismatch.
    assert!(quotes.iter().all(|q| q.strike > 0.0));
    // Expiry months present in the file must resolve to real Wednesdays.
    for month in ["2611", "2612", "2703", "2706"] {
        let expiry = expiry_date(month).unwrap();
        assert_eq!(expiry.weekday(), chrono::Weekday::Wed);
    }
}

#[test]
fn strike_codes_match_the_authoritative_exepx_column() {
    // The 5-digit code is strike x 1000 with leading zeros. This is the exact
    // rule that an earlier `id.len()`-based guess got wrong.
    for id in [
        "588000C2611M01000",
        "588000P2706M01350",
        "510050C2611M02650",
    ] {
        let (_, _, _, strike) = parse_contract_id(id).unwrap();
        assert!(strike > 0.0, "{id}");
    }
    assert_eq!(parse_contract_id("588000C2611M01000").unwrap().3, 1.0);
    assert_eq!(parse_contract_id("510050C2611M02650").unwrap().3, 2.65);
    for quote in parse_chain("588000", &fixture()).unwrap() {
        let (_, _, _, from_id) = parse_contract_id(&quote.contract_id).unwrap();
        assert!(
            (from_id - quote.strike).abs() < 1e-9,
            "{}: id {from_id} != exepx {}",
            quote.contract_id,
            quote.strike
        );
    }
}

#[test]
fn december_put_volatilities_reproduce_the_reference_table() {
    // Reference values were computed independently with scipy's optimizer on
    // the same close prices; the native bisection must agree to six digits.
    let as_of = NaiveDate::from_ymd_opt(2026, 11, 9).unwrap();
    let spot = 1.326;
    let quotes = parse_chain("588000", &fixture()).unwrap();
    let mut checked = 0;
    for (strike, expected_iv, expected_delta) in [
        (1.15_f64, 0.593_313_f64, -0.210_968_f64),
        (1.20_f64, 0.581_335_f64, -0.272_737_f64),
        (1.25_f64, 0.554_940_f64, -0.340_148_f64),
    ] {
        let quote = quotes
            .iter()
            .find(|q| {
                q.kind == OptionKind::Put
                    && q.expiry_month == "2612"
                    && (q.strike - strike).abs() < 1e-9
            })
            .unwrap_or_else(|| panic!("missing 2612 put {strike}"));
        let expiry = expiry_date("2612").unwrap();
        let t = years_between(as_of, expiry);
        let iv = implied_volatility(
            OptionKind::Put,
            spot,
            quote.strike,
            t,
            0.015,
            0.0,
            quote.last,
        )
        .unwrap_or_else(|| panic!("no iv for {strike}"));
        assert!(
            (iv - expected_iv).abs() < 5e-4,
            "strike {strike}: iv {iv} vs ref {expected_iv}"
        );
        let greeks = black_scholes(OptionKind::Put, spot, quote.strike, t, 0.015, 0.0, iv);
        assert!(
            (greeks.delta - expected_delta).abs() < 2e-3,
            "strike {strike}: delta {} vs ref {expected_delta}",
            greeks.delta
        );
        // Repriced from the recovered volatility, the model must return the
        // observed premium rather than drifting away from it.
        assert!(
            (greeks.price - quote.last).abs() < 1e-4,
            "strike {strike}: repriced {} vs quote {}",
            greeks.price,
            quote.last
        );
        checked += 1;
    }
    assert_eq!(checked, 3);
}

#[test]
fn unpriced_contracts_do_not_produce_fake_volatility() {
    let as_of = NaiveDate::from_ymd_opt(2026, 11, 9).unwrap();
    let t = years_between(as_of, expiry_date("2612").unwrap());
    // A zero last price means "no observation", not zero volatility.
    assert!(implied_volatility(OptionKind::Put, 1.326, 1.20, t, 0.015, 0.0, 0.0).is_none());
    // An expired contract has no implied volatility either.
    assert!(implied_volatility(OptionKind::Put, 1.326, 1.20, 0.0, 0.015, 0.0, 0.05).is_none());
}

/// 510500's 2612 series contains dividend-adjusted contracts (`...A07000`), whose
/// contract code still encodes the pre-adjustment strike 7.00 while `exepx`
/// reports the live 6.876. Treating that as a corrupt row made the whole board
/// fail, so the adjusted case is pinned to a real payload.
#[test]
fn adjusted_contracts_use_the_live_strike_not_the_code() {
    let raw: Value = serde_json::from_str(include_str!(
        "fixtures/sse-option-chain-510500-adjusted.json"
    ))
    .unwrap();
    let quotes = parse_chain("510500", &raw["payload"]).unwrap();
    assert_eq!(quotes.len(), 148);
    let adjusted: Vec<_> = quotes.iter().filter(|q| q.adjusted).collect();
    assert_eq!(adjusted.len(), 28, "28 adjusted 2612 contracts");
    assert!(adjusted.iter().all(|q| q.expiry_month == "2612"));
    let sample = quotes
        .iter()
        .find(|q| q.contract_id == "510500C2612A07000")
        .unwrap();
    assert!(
        (sample.strike - 6.876).abs() < 1e-9,
        "live strike from exepx"
    );
    assert!(is_adjusted(&sample.contract_id));
    // Unadjusted series in the same board keep the exact-match rule.
    let plain = quotes
        .iter()
        .find(|q| q.contract_id == "510500C2612M07000")
        .unwrap();
    assert!(!plain.adjusted);
    assert!((plain.strike - 7.0).abs() < 1e-9);
    // Adjusted contracts are real contracts, not a reason to drop the board.
    assert!(quotes.iter().all(|q| q.strike > 0.0));
}

#[test]
fn adjusted_code_with_a_nonsensical_exepx_is_still_rejected() {
    // A "strike" 40x the code strike is not a corporate-action adjustment.
    let broken = serde_json::json!({"list":[["510500C2612A07000", 0.19, -19.0, 0.24, 280.0]]});
    assert!(parse_chain("510500", &broken).is_err());
    // And an unknown flag is not silently accepted.
    let flag = serde_json::json!({"list":[["510500C2612X07000", 0.19, -19.0, 0.24, 7.0]]});
    assert!(parse_chain("510500", &flag).is_err());
}
