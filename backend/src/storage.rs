use anyhow::{Context, Result, bail};
use serde_json::Value;
use std::{
    fs,
    path::{Component, Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

#[derive(Clone)]
pub struct ObjectStore {
    root: Arc<PathBuf>,
}

impl ObjectStore {
    pub fn new(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(&root)?;
        Ok(Self {
            root: Arc::new(root.canonicalize()?),
        })
    }

    fn path(&self, key: &str, create_parents: bool) -> Result<PathBuf> {
        if key.is_empty() {
            bail!("empty local object key");
        }
        let key = Path::new(key);
        if key
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        {
            bail!("invalid local object key");
        }
        let path = self.root.join(key);
        let parent = path.parent().context("object key has no parent")?;
        let mut current = self.root.as_ref().clone();
        for part in key.components() {
            current.push(part);
            match fs::symlink_metadata(&current) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    bail!("object store symlinks are forbidden")
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        if create_parents {
            fs::create_dir_all(parent)?;
        }
        Ok(path)
    }

    pub async fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        let store = self.clone();
        let key = key.to_string();
        tokio::task::spawn_blocking(move || match fs::read(store.path(&key, false)?) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        })
        .await?
    }

    pub async fn get_json(&self, key: &str) -> Result<Option<Value>> {
        self.get(key)
            .await?
            .map(|bytes| serde_json::from_slice(&bytes).map_err(Into::into))
            .transpose()
    }

    pub async fn put_json(&self, key: &str, value: &Value) -> Result<()> {
        self.put(key, serde_json::to_vec(value)?).await
    }

    pub async fn put(&self, key: &str, bytes: Vec<u8>) -> Result<()> {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let store = self.clone();
        let key = key.to_string();
        tokio::task::spawn_blocking(move || {
            use std::io::Write;
            let path = store.path(&key, true)?;
            let temporary = path.with_file_name(format!(
                ".stock-info-{}-{}-{}",
                std::process::id(),
                chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            let result = (|| -> Result<()> {
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temporary)?;
                file.write_all(&bytes)?;
                file.sync_all()?;
                fs::rename(&temporary, &path)?;
                Ok(())
            })();
            if result.is_err() {
                let _ = fs::remove_file(&temporary);
            }
            result
        })
        .await?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn roundtrip_and_traversal_boundary() {
        let root = tempfile::tempdir().unwrap();
        let store = ObjectStore::new(root.path().join("objects")).unwrap();
        assert!(store.get_json("missing/file.json").await.unwrap().is_none());
        store
            .put_json("nested/file.json", &serde_json::json!({"safe":true}))
            .await
            .unwrap();
        assert_eq!(
            store.get_json("nested/file.json").await.unwrap(),
            Some(serde_json::json!({"safe":true}))
        );
        for key in ["../private", "/absolute", "a/../../secret", ""] {
            assert!(store.get(key).await.is_err());
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.path(), root.path().join("objects/link")).unwrap();
            assert!(store.get("link/private").await.is_err());
            assert!(store.put("link/private", vec![1]).await.is_err());
        }
    }
}
