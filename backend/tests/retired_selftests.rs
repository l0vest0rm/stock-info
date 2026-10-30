//! The legacy assertion bodies remain executable, but their domain calls now
//! cross the native stateless bridge. This inventory prevents silently dropping
//! one of those checks when removing the old TypeScript implementation.
use serde_json::Value;
use std::path::Path;
#[test]
fn retained_assertion_inventory_preserves_all_nineteen_scripts() {
    let manifest: Value =
        serde_json::from_str(include_str!("fixtures/retired-selftest-assertions.json")).unwrap();
    let scripts = manifest["scripts"].as_array().unwrap();
    assert_eq!(scripts.len(), 19);
    assert_eq!(manifest["sourceCommit"], "9ebbeef");
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut total = 0;
    for item in scripts {
        let path = item["script"].as_str().unwrap();
        let source = std::fs::read_to_string(root.join(path)).unwrap();
        let assertions = source.matches("assert.").count();
        assert_eq!(
            assertions as u64,
            item["assertions"].as_u64().unwrap(),
            "assertion coverage changed: {path}"
        );
        assert!(
            !source.contains("../src/"),
            "retired backend dependency: {path}"
        );
        assert!(
            source.contains("./lib/rust-analysis.mjs"),
            "domain must execute in native Rust: {path}"
        );
        assert_eq!(item["sha256"].as_str().unwrap().len(), 64);
        total += assertions;
    }
    assert_eq!(total, 539);
}
