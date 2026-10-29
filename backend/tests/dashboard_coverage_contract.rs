use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use stock_info_local::coverage;

#[test]
fn entire_public_coverage_matches_typescript_reference() {
    let result = coverage::read();
    assert_eq!(result["companyCount"], 98);
    // Golden is the canonical-key JSON from the original source, including all
    // company methods, factors, evidence tiers, channels, gaps and limitations.
    let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&result).unwrap()));
    assert_eq!(
        digest,
        "45a0f3bd48b47ec7bc0e24063376032b4cc6cdf3ec30939981c5afa565ce54d3"
    );
}

#[test]
fn issuer_identity_tracks_all_listing_lines_and_narrow_us_alias() {
    assert_eq!(
        coverage::company_archetype("600036.SH"),
        Some("bank".into())
    );
    assert_eq!(coverage::company_archetype("03968.HK"), Some("bank".into()));
    assert_eq!(
        coverage::company_archetype("NVDA.US"),
        coverage::company_archetype("NVDA")
    );
    assert_eq!(coverage::company_archetype("not-a-security"), None);
    assert_eq!(
        coverage::resolve_archetype("IND-06", Some("co-0123"))["archetype"],
        "stable_cash_dividend"
    );
    assert_eq!(
        coverage::resolve_archetype("unknown", None)["archetype"],
        "other"
    );
}

#[test]
fn absent_universe_and_unverified_identity_do_not_invent_coverage() {
    let empty = coverage::build(&json!({"companies":[]}), &json!({}), &json!({}));
    assert_eq!(empty["companyCount"], 0);
    assert!(!empty["gaps"].as_array().unwrap().is_empty());
    let company = json!({"valuationProfile":{"archetype":"software_platform"},"factors":[{"weight":"primary","direction":"mixed"}]});
    assert_eq!(
        coverage::research_tier(&company, 3, false)["priority"],
        "L1"
    );
    assert_eq!(coverage::research_tier(&company, 3, true)["priority"], "L2");
    assert_eq!(coverage::research_tier(&company, 0, true)["priority"], "L1");
    assert_ne!(coverage::valuation_profile("bank"), Value::Null);
}
