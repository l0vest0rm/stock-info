include!("../../crates/securities-data/tests/support/host_cache_probe.rs");

#[tokio::test]
#[ignore = "run Trade's scripts/test_shared_securities_cache.sh with an isolated public DB"]
async fn public_cache_process_probe() -> Result<()> {
    let root = probe_dir()?;
    let db = crate::db::Database::open(root.join("stock-info-private.sqlite"))?;
    let state = crate::AppState::new(db, root, "127.0.0.1:0".to_owned())?;
    run_provider(&state).await
}
