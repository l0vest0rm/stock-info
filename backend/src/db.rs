use anyhow::{Context, Result, bail};
use rusqlite::Connection;
use std::{fs, path::Path, sync::Arc, time::Duration};

/// A connection is created on the blocking pool per operation: SQLite's busy
/// wait must never block an async executor or hold a mutex across an await.
#[derive(Clone)]
pub struct Database(Arc<std::path::PathBuf>);

impl Database {
    pub async fn query(
        &self,
        sql: impl Into<String>,
        params: Vec<serde_json::Value>,
    ) -> Result<Vec<serde_json::Value>> {
        let sql = sql.into();
        self.run(move |conn| {
            let mut stmt = conn.prepare(&sql)?;
            let names: Vec<String> = stmt
                .column_names()
                .iter()
                .map(|name| name.to_string())
                .collect();
            let values = params.iter().map(sql_value).collect::<Vec<_>>();
            let rows = stmt
                .query_map(rusqlite::params_from_iter(values), |row| {
                    let mut object = serde_json::Map::new();
                    for (index, name) in names.iter().enumerate() {
                        use rusqlite::types::ValueRef;
                        let value = match row.get_ref(index)? {
                            ValueRef::Null => serde_json::Value::Null,
                            ValueRef::Integer(n) => n.into(),
                            ValueRef::Real(n) => serde_json::json!(n),
                            ValueRef::Text(s) => String::from_utf8_lossy(s).into_owned().into(),
                            ValueRef::Blob(b) => serde_json::json!(b),
                        };
                        object.insert(name.clone(), value);
                    }
                    Ok(serde_json::Value::Object(object))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .await
    }

    pub async fn execute(
        &self,
        sql: impl Into<String>,
        params: Vec<serde_json::Value>,
    ) -> Result<usize> {
        let sql = sql.into();
        self.run(move |conn| {
            Ok(conn.execute(
                &sql,
                rusqlite::params_from_iter(params.iter().map(sql_value)),
            )?)
        })
        .await
    }

    pub async fn get_kv(&self, namespace: &str, key: &str) -> Result<Option<serde_json::Value>> {
        let rows = self.query("SELECT value_json FROM kv_cache WHERE namespace=? AND key=? AND (expires_at IS NULL OR expires_at>?)", vec![namespace.into(), key.into(), chrono::Utc::now().timestamp_millis().into()]).await?;
        rows.first()
            .map(|row| {
                serde_json::from_str(row["value_json"].as_str().unwrap_or("null"))
                    .map_err(Into::into)
            })
            .transpose()
    }

    pub async fn put_kv(
        &self,
        namespace: &str,
        key: &str,
        value: &serde_json::Value,
        expires: Option<i64>,
    ) -> Result<()> {
        self.execute("INSERT INTO kv_cache(namespace,key,value_json,expires_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value_json=excluded.value_json,expires_at=excluded.expires_at,updated_at=excluded.updated_at", vec![namespace.into(),key.into(),serde_json::to_string(value)?.into(),serde_json::json!(expires),chrono::Utc::now().timestamp_millis().into()]).await?;
        Ok(())
    }
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let db = Self(Arc::new(path.to_path_buf()));
        let conn = db.connect()?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        Ok(db)
    }

    pub fn connect(&self) -> Result<Connection> {
        let conn = Connection::open(self.0.as_ref())?;
        conn.busy_timeout(Duration::from_secs(30))?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Ok(conn)
    }

    pub async fn run<T, F>(&self, operation: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    {
        let db = self.clone();
        tokio::task::spawn_blocking(move || operation(&mut db.connect()?)).await?
    }

    /// Retains the Node migrator's sorted-file/user_version contract. Never
    /// invents a migrations table or rewrites historical migrations.
    pub fn migrate(&self, directory: &Path) -> Result<usize> {
        let mut files = fs::read_dir(directory)?
            .map(|entry| entry.map(|entry| entry.path()))
            .collect::<std::io::Result<Vec<_>>>()?;
        files.retain(|path| path.extension().is_some_and(|ext| ext == "sql"));
        files.sort();
        let mut conn = self.connect()?;
        let mut applied = 0;
        loop {
            // Read version after taking the write lock. Concurrent migrators
            // must not both apply a migration selected before either commits.
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let version: usize = tx.pragma_query_value(None, "user_version", |row| row.get(0))?;
            if version > files.len() {
                bail!(
                    "database version {version} exceeds {} migration files",
                    files.len()
                );
            }
            let Some(file) = files.get(version) else {
                break;
            };
            tx.execute_batch(&fs::read_to_string(file)?)
                .with_context(|| format!("migration failed: {}", file.display()))?;
            tx.pragma_update(None, "user_version", version + 1)?;
            tx.commit()?;
            applied += 1;
        }
        Ok(applied)
    }
}

pub fn sql_value(value: &serde_json::Value) -> rusqlite::types::Value {
    match value {
        serde_json::Value::Null => rusqlite::types::Value::Null,
        serde_json::Value::Bool(b) => rusqlite::types::Value::Integer(i64::from(*b)),
        serde_json::Value::Number(n) if n.is_i64() => {
            rusqlite::types::Value::Integer(n.as_i64().unwrap())
        }
        serde_json::Value::Number(n) => rusqlite::types::Value::Real(n.as_f64().unwrap()),
        serde_json::Value::String(s) => rusqlite::types::Value::Text(s.clone()),
        value => rusqlite::types::Value::Text(value.to_string()),
    }
}
