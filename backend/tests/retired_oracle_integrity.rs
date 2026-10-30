//! Immutable original-source evidence, independent of Node and the retired tree.
use std::io::Read;

use serde_json::Value;
use sha2::{Digest, Sha256};

#[test]
fn frozen_original_backend_matrices_keep_capture_hashes_and_complete_case_counts() {
    let manifest: Value =
        serde_json::from_str(include_str!("fixtures/retired-backend-oracles.json")).unwrap();
    assert_eq!(manifest["sourceCommit"].as_str().unwrap().len(), 40);
    let fixtures = [
        (
            "dashboard_domain_opportunity.json.gz",
            343,
            include_bytes!("fixtures/dashboard_domain_opportunity.json.gz").as_slice(),
        ),
        (
            "dashboard_screen_diff.json.gz",
            65,
            include_bytes!("fixtures/dashboard_screen_diff.json.gz").as_slice(),
        ),
    ];
    assert_eq!(
        manifest["fixtures"].as_array().unwrap().len(),
        fixtures.len()
    );
    for (name, count, compressed) in fixtures {
        let metadata = manifest["fixtures"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["file"] == name)
            .unwrap();
        let mut decoded = Vec::new();
        flate2::read::GzDecoder::new(compressed)
            .read_to_end(&mut decoded)
            .unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(&decoded)),
            metadata["decodedSha256"].as_str().unwrap(),
            "{name}: original captured bytes changed"
        );
        let cases: Vec<Value> = serde_json::from_slice(&decoded).unwrap();
        assert_eq!(cases.len(), count, "{name}: complete matrix required");
        assert_eq!(metadata["caseCount"], count);
        for case in cases {
            assert!(case["input"].is_object(), "{name}: missing complete input");
            assert!(
                case["expected"].is_object() || case["expected"].is_array(),
                "{name}: missing complete output"
            );
        }
    }
}
