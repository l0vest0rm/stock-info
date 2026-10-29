use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use stock_info_local::dashboard::comparability;

#[test]
fn complete_peer_matrices_match_original_source_for_all_pair_gates() {
    let codes = [
        "300308.SZ",
        "300394.SZ",
        "002594.SZ",
        "600519.SH",
        "600036.SH",
        "601919.SH",
        "601899.SH",
        "601318.SH",
    ];
    let ratios = [
        Some(0.07),
        Some(0.2),
        Some(5.6),
        Some(0.04),
        None,
        Some(0.6),
        Some(0.5),
        None,
    ];
    let reading = |index: usize| json!({"code":codes[index],"depreciationToEbit":ratios[index],"midCycleAvailable":index.is_multiple_of(2),"availableMetrics":if index.is_multiple_of(3) {json!(["pe_ttm"])} else {Value::Null}});
    let results:Vec<Value>=(0..codes.len()).map(|i|comparability::build(&json!({"company":reading(i),"peers":(0..codes.len()).map(reading).collect::<Vec<_>>()}))).collect();
    let digest = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&results).unwrap())
    );
    assert_eq!(
        digest,
        "c82a0621dbba2a98b022595380da3c345a7b9388d4acb5d4e95de01da0cdd2d0"
    );
    // Compile-check the real live measurement API, not a mock implementation.
    let _real_measurement_api = comparability::load;
}
