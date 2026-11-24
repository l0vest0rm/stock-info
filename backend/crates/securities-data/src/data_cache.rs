//! Disposable public data only. No credentials, account snapshots or trading operations.
//! Namespaces are versioned provider contracts; callers validate payloads before admission.
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    future::Future,
    path::PathBuf,
    sync::{Arc, LazyLock, Mutex, OnceLock, Weak},
    time::Duration,
};
use std::{error::Error, fmt};

const MAX_ENTRY: usize = 8 << 20;
const MAX_BYTES: i64 = 128 << 20;
const MAX_ROWS: i64 = 4096;
const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS kv (
 namespace TEXT NOT NULL, key TEXT NOT NULL, value BLOB NOT NULL,
 content_version BLOB NOT NULL, checked_at INTEGER NOT NULL, recheck_at INTEGER NOT NULL,
 PRIMARY KEY(namespace,key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS kv_age ON kv(checked_at,namespace,key);";

const APPLICATION_ID: i32 = 0x5345434B; // SECK
fn identified(db: &Connection) -> Result<bool> {
    let id: i32 = db.pragma_query_value(None, "application_id", |row| row.get(0))?;
    anyhow::ensure!(
        id == 0 || id == APPLICATION_ID,
        "not a public securities cache"
    );
    Ok(id == APPLICATION_ID)
}
// An explicitly selected pre-sharing Trade database has no application_id.
// Recognize only the exact former disposable schema, never a host database
// that happens to have a table named kv. Preserve its rows in place.
fn original_layout(db: &Connection) -> rusqlite::Result<bool> {
    let mut q = db.prepare(
        "SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type DESC,name",
    )?;
    let rows = q
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if rows.len() != 2 {
        return Ok(false);
    }
    let normalize = |sql: &str| {
        sql.replace(" IF NOT EXISTS", "")
            .split_whitespace()
            .collect::<String>()
    };
    Ok(rows.iter().map(|r| normalize(r)).eq(SCHEMA
        .split(';')
        .filter(|s| !s.trim().is_empty())
        .map(normalize)))
}
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
// Map insertion order is not a semantic dependency; array order is.
fn digest<T: Serialize>(v: &T) -> Result<String> {
    let mut v = serde_json::to_value(v)?;
    v.sort_all_objects();
    let mut hasher = Sha256::new();
    serde_json::to_writer(&mut hasher, &v)?;
    Ok(format!("{:x}", hasher.finalize()))
}

#[derive(Clone, Hash, Eq, PartialEq)]
struct Flight(PathBuf, &'static str, String);
type Flights<T> = LazyLock<Mutex<HashMap<Flight, Weak<T>>>>;
// Keep typed transport failures inspectable by every waiter; never persist an error.
#[derive(Clone, Debug)]
struct SharedError(Arc<anyhow::Error>);
impl fmt::Display for SharedError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&*self.0, f)
    }
}
impl Error for SharedError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(self.0.as_ref().as_ref())
    }
}
impl From<anyhow::Error> for SharedError {
    fn from(e: anyhow::Error) -> Self {
        Self(Arc::new(e))
    }
}
type Outcome = std::result::Result<Value, SharedError>;
// Opt-in rollback/comparison without deleting data or changing any public API.
static BYPASS: LazyLock<Vec<String>> = LazyLock::new(|| {
    std::env::var("TRADE_CACHE_BYPASS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
});
fn bypass(ns: &str) -> bool {
    BYPASS.iter().any(|s| s == "*" || s == ns)
}
static TRACE: LazyLock<bool> = LazyLock::new(|| std::env::var_os("TRADE_CACHE_TRACE").is_some());
fn event(ns: &str, label: &str) {
    if *TRACE {
        eprintln!("public_cache dataset={ns} action={label}");
    }
}
static ASYNC: Flights<tokio::sync::OnceCell<Outcome>> = LazyLock::new(Default::default);
static SYNC: Flights<OnceLock<Outcome>> = LazyLock::new(Default::default);
fn flight<T: Default>(flights: &Flights<T>, key: Flight, pending: impl Fn(&T) -> bool) -> Arc<T> {
    let mut map = flights.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(existing) = map.get(&key).and_then(Weak::upgrade)
        && pending(&existing)
    {
        event(key.1, "join");
        return existing;
    }
    map.retain(|_, v| v.strong_count() > 0);
    let cell = Arc::new(T::default());
    map.insert(key, Arc::downgrade(&cell));
    cell
}

#[derive(Clone)]
pub struct Cache(PathBuf);

impl Cache {
    /// Explicit isolated file (e.g. tests). Never resolve relative to process cwd.
    pub fn at(path: PathBuf) -> Self {
        Self(path)
    }

    /// Both production hosts call this same resolver, including installed/standalone builds.
    /// An invalid explicit override disables disk reuse; it never selects a second database.
    pub fn shared() -> Self {
        let path = match std::env::var_os("SECURITIES_PUBLIC_CACHE_DB") {
            Some(path) => PathBuf::from(path),
            None => std::env::home_dir()
                .map(|p| p.join(".cache/securities-data/public.sqlite3"))
                .unwrap_or_default(),
        };
        Self::at(path)
    }
    fn open(&self) -> Result<Connection> {
        anyhow::ensure!(
            self.0.is_absolute(),
            "public cache requires an absolute path"
        );
        std::fs::create_dir_all(
            self.0
                .parent()
                .ok_or_else(|| anyhow::anyhow!("invalid public cache path"))?,
        )?;
        let db = Connection::open(&self.0)?;
        db.busy_timeout(Duration::from_millis(250))?;
        if !identified(&db)? {
            // Only claim a fresh file, never add our table to a host business database.
            db.execute_batch("BEGIN IMMEDIATE")?;
            if !identified(&db)? {
                let empty: bool = db.query_row(
                    "SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*')",
                    [],
                    |r| r.get(0),
                )?;
                anyhow::ensure!(
                    empty || original_layout(&db)?,
                    "not a dedicated public cache database"
                );
                if empty {
                    db.execute_batch(SCHEMA)?;
                }
                db.pragma_update(None, "application_id", APPLICATION_ID)?;
            }
            db.execute_batch("COMMIT")?;
        }
        Ok(db)
    }
    fn read(&self, ns: &str, key: &str, at: i64, max_age: i64) -> Option<Vec<u8>> {
        if !self.0.is_absolute() {
            return None;
        }
        // Cold misses do not create directories, databases or take DDL locks.
        let db = Connection::open_with_flags(&self.0, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .ok()?;
        db.busy_timeout(Duration::from_millis(250)).ok()?;
        if !identified(&db).ok()? && !original_layout(&db).ok()? {
            return None;
        }
        let (bytes, checksum): (Vec<u8>, Vec<u8>) = db.query_row(
            "SELECT value,content_version FROM kv WHERE namespace=? AND key=? AND checked_at<=? AND recheck_at>? AND checked_at>? AND length(value)<=?",
            params![ns,key,at,at,at.saturating_sub(max_age),MAX_ENTRY as i64], |r| Ok((r.get(0)?,r.get(1)?))
        ).optional().ok()??;
        (Sha256::digest(&bytes)[..] == checksum).then_some(bytes)
    }
    fn write(&self, ns: &str, key: &str, bytes: &[u8], at: i64, until: i64) -> Result<()> {
        if bytes.len() > MAX_ENTRY || until <= at {
            event(ns, "admission_bypass");
            return Ok(());
        }
        let mut db = self.open()?;
        let tx = db.transaction()?;
        tx.execute("INSERT INTO kv VALUES(?,?,?,?,?,?)
            ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value,content_version=excluded.content_version,
            checked_at=excluded.checked_at,recheck_at=excluded.recheck_at WHERE excluded.checked_at>=kv.checked_at",
            params![ns,key,bytes,&Sha256::digest(bytes)[..],at,until])?;
        let (mut count, mut size): (i64, i64) =
            tx.query_row("SELECT count(*),sum(length(value)) FROM kv", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?;
        while count > MAX_ROWS || size > MAX_BYTES {
            let (n,k,removed): (String,String,i64) = tx.query_row(
                "SELECT namespace,key,length(value) FROM kv ORDER BY checked_at,namespace,key LIMIT 1", [],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?;
            tx.execute("DELETE FROM kv WHERE namespace=? AND key=?", params![n, k])?;
            count -= 1;
            size -= removed;
        }
        tx.commit()?;
        Ok(())
    }
    // Compatibility bridge for a provider API that owns response-derived absolute expiry.
    pub fn read_text(&self, ns: &'static str, key: &str, at: i64) -> Option<String> {
        if bypass(ns) {
            return None;
        }
        String::from_utf8(self.read(ns, &hash(key.as_bytes()), at, i64::MAX)?).ok()
    }
    pub fn write_text(&self, ns: &'static str, key: &str, value: &str, at: i64, until: i64) {
        if !bypass(ns)
            && self
                .write(ns, &hash(key.as_bytes()), value.as_bytes(), at, until)
                .is_err()
        {
            event(ns, "storage_unavailable");
        }
    }
    fn get(&self, ns: &str, key: &str, at: i64, max_age: i64) -> Option<Value> {
        serde_json::from_slice(&self.read(ns, key, at, max_age)?).ok()
    }
    fn put(&self, ns: &str, key: &str, value: &Value, at: i64, until: i64) {
        let mut canonical = value.clone();
        canonical.sort_all_objects();
        if let Ok(bytes) = serde_json::to_vec(&canonical)
            && self.write(ns, key, &bytes, at, until).is_err()
        {
            event(ns, "storage_unavailable");
        }
    }
    /// TTL starts at request admission, not when a slow upstream finishes. No stale fallback.
    pub async fn fetch<K, F>(
        &self,
        ns: &'static str,
        key: &K,
        ttl_ms: i64,
        load: impl FnOnce() -> F,
    ) -> Result<Value>
    where
        K: Serialize,
        F: Future<Output = Result<Value>>,
    {
        if ttl_ms <= 0 || bypass(ns) {
            return load().await;
        }
        let key = digest(key)?;
        let cell = flight(
            &ASYNC,
            Flight(self.0.clone(), ns, format!("{key}:{ttl_ms}")),
            |cell| cell.get().is_none(),
        );
        cell.get_or_init(|| async {
            let reader = self.clone();
            let lookup = key.clone();
            if let Some(v) =
                tokio::task::spawn_blocking(move || reader.get(ns, &lookup, now(), ttl_ms))
                    .await
                    .ok()
                    .flatten()
            {
                event(ns, "hit");
                return Ok(v);
            }
            event(ns, "fetch");
            let at = now();
            let v = load().await.map_err(SharedError::from)?;
            let writer = self.clone();
            tokio::task::spawn_blocking(move || {
                writer.put(ns, &key, &v, at, at.saturating_add(ttl_ms));
                v
            })
            .await
            .map_err(|e| SharedError::from(anyhow::Error::from(e)))
        })
        .await
        .clone()
        .map_err(anyhow::Error::new)
    }
    pub fn fetch_sync_if<K: Serialize>(
        &self,
        ns: &'static str,
        key: &K,
        ttl_ms: i64,
        load: impl FnOnce() -> Result<Value>,
        admit: impl Fn(&Value) -> bool,
    ) -> Result<Value> {
        if ttl_ms <= 0 || bypass(ns) {
            return load();
        }
        self.resolve(ns, digest(key)?, ttl_ms, load, admit)
    }
    fn resolve(
        &self,
        ns: &'static str,
        key: String,
        ttl: i64,
        load: impl FnOnce() -> Result<Value>,
        admit: impl Fn(&Value) -> bool,
    ) -> Result<Value> {
        let cell = flight(&SYNC, Flight(self.0.clone(), ns, key.clone()), |cell| {
            cell.get().is_none()
        });
        cell.get_or_init(|| {
            let at = now();
            if let Some(v) = self.get(ns, &key, at, ttl).filter(&admit) {
                event(ns, "hit");
                return Ok(v);
            }
            event(ns, "load_or_compute");
            let v = load().map_err(SharedError::from)?;
            if admit(&v) {
                self.put(ns, &key, &v, at, at.saturating_add(ttl));
            }
            Ok(v)
        })
        .clone()
        .map_err(anyhow::Error::new)
    }
    /// Merge overlapping public reads without storing their composite response.
    pub fn share_sync<K: Serialize>(
        &self,
        ns: &'static str,
        key: &K,
        load: impl FnOnce() -> Result<Value>,
    ) -> Result<Value> {
        if bypass(ns) {
            return load();
        }
        let cell = flight(&SYNC, Flight(self.0.clone(), ns, digest(key)?), |cell| {
            cell.get().is_none()
        });
        cell.get_or_init(|| load().map_err(SharedError::from))
            .clone()
            .map_err(anyhow::Error::new)
    }
    /// Inputs must be verified for this request before calling. Namespace versions the algorithm.
    pub fn compute<K: Serialize, I: Serialize>(
        &self,
        ns: &'static str,
        key: &K,
        inputs: &I,
        load: impl FnOnce() -> Result<Value>,
    ) -> Result<Value> {
        if bypass(ns) {
            return load();
        }
        self.resolve(ns, digest(&(key, inputs))?, i64::MAX, load, |_| true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{
        Barrier,
        atomic::{AtomicUsize, Ordering},
    };
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("trade-kv-{}", rand::random::<u128>())))
        }
        fn cache(&self) -> Cache {
            Cache::at(self.0.join("data/workbench-cache.sqlite3"))
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn exact_legacy_store_can_be_reused_in_place() {
        let tmp = Temp::new();
        let c = tmp.cache();
        c.write_text("legacy", "page", "original", 1, 50);
        let db = c.open().unwrap();
        db.pragma_update(None, "application_id", 0).unwrap();
        assert!(original_layout(&db).unwrap());
        assert_eq!(
            c.read_text("legacy", "page", 2).as_deref(),
            Some("original")
        );
        c.write_text("legacy", "page", "new", 5, 50);
        assert!(identified(&db).unwrap());
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM kv", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    #[test]
    fn never_adopt_an_unrelated_sqlite_database() {
        let t = Temp::new();
        std::fs::create_dir_all(&t.0).unwrap();
        let path = t.0.join("business.sqlite3");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE existing(value TEXT)")
            .unwrap();
        let c = Cache::at(path);
        assert_eq!(c.compute("test", &1, &(), || Ok(json!(8))).unwrap(), 8);
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM sqlite_schema WHERE type='table'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert!(!identified(&db).unwrap());
    }

    #[test]
    fn deadlines_revision_and_reopen() {
        let t = Temp::new();
        let c = t.cache();
        c.write_text("source", "q", "one", 100, 150);
        assert_eq!(c.read_text("source", "q", 99), None);
        assert_eq!(
            t.cache().read_text("source", "q", 149).as_deref(),
            Some("one")
        );
        assert_eq!(c.read_text("source", "q", 150), None);
        c.write_text("source", "q", "two", 150, 200);
        c.write_text("source", "q", "obsolete", 140, 999);
        assert_eq!(c.read_text("source", "q", 150).as_deref(), Some("two"));
        assert_eq!(c.read_text("other", "q", 150), None);
    }

    #[test]
    fn unchanged_reordered_inputs_hit_revisions_and_new_algorithm_miss() {
        let t = Temp::new();
        let calc = |ns, v: &Value| t.cache().compute(ns, &"x", v, || Ok(json!(ns))).unwrap();
        assert_eq!(calc("calc.v1", &json!({"a":1,"b":[2,3]})), "calc.v1");
        let result = t
            .cache()
            .compute("calc.v1", &"x", &json!({"b":[2,3],"a":1}), || {
                panic!("reordered map miss")
            })
            .unwrap();
        assert_eq!(result, "calc.v1");
        assert_eq!(calc("calc.v2", &json!({"a":1,"b":[2,3]})), "calc.v2");
        assert_eq!(
            t.cache()
                .compute("calc.v1", &"x", &json!({"a":1,"b":[3,2]}), || Ok(json!(
                    "revision"
                )))
                .unwrap(),
            "revision"
        );
    }
    #[test]
    fn stricter_policy_quota_and_no_store() {
        let t = Temp::new();
        let c = t.cache();
        assert_eq!(c.share_sync("no-store", &1, || Ok(json!(1))).unwrap(), 1);
        assert!(!c.0.exists());
        let key = digest(&"q").unwrap();
        c.put("p", &key, &json!(1), 100, 2000);
        assert_eq!(c.get("p", &key, 111, 10), None);
        assert_eq!(c.get("p", &key, 111, 12), Some(json!(1)));
        let db = c.open().unwrap();
        db.execute("WITH RECURSIVE s(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM s WHERE i<?) INSERT INTO kv SELECT 'quota',printf('%04d',i),x'01',x'00',1,2 FROM s",[MAX_ROWS]).unwrap();
        c.put("p", "new", &json!(2), 200, 201);
        assert_eq!(
            db.query_row("SELECT count(*) FROM kv", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            MAX_ROWS
        );
        assert_eq!(c.get("p", "new", 200, 1), Some(json!(2)));
    }
    #[test]
    fn concurrent_sync_public_reads_load_once() {
        let t = Temp::new();
        let c = t.cache();
        let n = AtomicUsize::new(0);
        let ready = Barrier::new(4);
        std::thread::scope(|s| {
            for _ in 0..4 {
                s.spawn(|| {
                    ready.wait();
                    assert_eq!(
                        c.fetch_sync_if(
                            "source",
                            &"q",
                            10000,
                            || {
                                n.fetch_add(1, Ordering::Relaxed);
                                std::thread::sleep(Duration::from_millis(15));
                                Ok(json!(42))
                            },
                            |_| true
                        )
                        .unwrap(),
                        42
                    );
                });
            }
        });
        assert_eq!(n.load(Ordering::Relaxed), 1);
    }
    #[tokio::test]
    async fn overlapping_fetches_share_loader_expiry_does_not_hide_errors() {
        let t = Temp::new();
        let c = t.cache();
        let calls = AtomicUsize::new(0);
        let load = || async {
            calls.fetch_add(1, Ordering::Relaxed);
            tokio::task::yield_now().await;
            Ok(json!(42))
        };
        let (a, b) = tokio::join!(
            c.fetch("s", &"x", 5000, load),
            c.fetch("s", &"x", 5000, load)
        );
        assert_eq!(a.unwrap(), b.unwrap());
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        let db = c.open().unwrap();
        db.execute("UPDATE kv SET recheck_at=checked_at", [])
            .unwrap();
        assert!(
            c.fetch("s", &"x", 5000, || async { anyhow::bail!("failed") })
                .await
                .is_err()
        );
        assert_eq!(
            c.fetch("s", &"x", 5000, || async { Ok(json!(43)) })
                .await
                .unwrap(),
            43
        );
        assert_eq!(
            c.fetch("s", &"x", 0, || async { Ok(json!(0)) })
                .await
                .unwrap(),
            0
        );
    }
    #[test]
    fn admission_corruption_and_disk_failure() {
        let t = Temp::new();
        let c = t.cache();
        let get = |value| {
            c.fetch_sync_if("v", &"x", 5000, || Ok(json!(value)), |v| v == 42)
                .unwrap()
        };
        assert_eq!(get(41), 41);
        assert_eq!(get(42), 42);
        assert_eq!(get(41), 42);
        c.open()
            .unwrap()
            .execute("UPDATE kv SET value=x'3333'", [])
            .unwrap();
        assert_eq!(get(41), 41);
        let bad = Temp::new();
        std::fs::create_dir_all(bad.0.join("data")).unwrap();
        std::fs::write(
            bad.0.join("data/workbench-cache.sqlite3"),
            b"not a database",
        )
        .unwrap();
        assert_eq!(
            bad.cache()
                .compute("v", &"k", &(), || Ok(json!(9)))
                .unwrap(),
            9
        );
    }
}
