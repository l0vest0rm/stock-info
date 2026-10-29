//! Native local Xueqiu credential lifecycle. Only a validated API-scoped CDP
//! session is persisted, and existing Chrome processes/targets are not owned.
use crate::AppState;
use anyhow::{Context, Result, bail};
use chrono::{SecondsFormat, Utc};
use futures_util::{SinkExt, StreamExt};
use reqwest::{Client, Method, Url, header::HeaderMap};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
    sync::OnceLock,
    time::Duration,
};
use tempfile::TempDir;
use tokio::{
    net::TcpStream,
    process::{Child, Command},
    sync::Mutex,
};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async, tungstenite::Message};

const KLINE_URL: &str = "https://stock.xueqiu.com/v5/stock/chart/kline.json";
const PAGE_URL: &str = "https://xueqiu.com/v5/stock/chart/kline.json";
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

pub fn credential_path(state: &AppState) -> PathBuf {
    let configured = state.setting("LOCAL_XUEQIU_CREDENTIAL_STORE");
    if configured.trim().is_empty() {
        state.data_dir().join("runtime/xueqiu-credential.json")
    } else {
        state.root.join(configured)
    }
}

fn fingerprint(cookie: &str) -> String {
    format!("{:x}", Sha256::digest(cookie.as_bytes()))[..16].to_string()
}

/// Restricts credential-bearing browser RPC to a local debugging endpoint.
fn local_endpoint(value: &str, websocket: bool) -> Result<Url> {
    let url = Url::parse(value).context("invalid local Chrome CDP endpoint")?;
    let allowed_scheme = if websocket {
        url.scheme() == "ws"
    } else {
        url.scheme() == "http"
    };
    let loopback = url.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
            || host == "[::1]"
    });
    if !allowed_scheme || !loopback || !url.username().is_empty() || url.password().is_some() {
        bail!("Chrome CDP must use a loopback HTTP/WebSocket endpoint without URL credentials");
    }
    Ok(url)
}

pub fn cookie_header_from_cdp(cookies: &Value) -> String {
    let mut pairs = cookies
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|cookie| {
            let raw_name = cookie["name"].as_str()?;
            let raw_value = cookie["value"].as_str()?;
            // Validate before normalization: trim() would otherwise erase a
            // trailing CR/LF and turn an injected cookie into an accepted one.
            if raw_name.chars().any(char::is_control)
                || raw_value.chars().any(char::is_control)
                || raw_value.contains(';')
            {
                return None;
            }
            let name = raw_name.trim();
            let value = raw_value.trim();
            let domain = cookie["domain"]
                .as_str()
                .unwrap_or("")
                .trim_start_matches('.');
            // Network.getCookies is requested for the API origin. Also defend this
            // adapter against suffix lookalikes when fed an untrusted CDP payload.
            if name.is_empty() || !(domain == "xueqiu.com" || domain.ends_with(".xueqiu.com")) {
                return None;
            }
            if name.contains([';', '\r', '\n', '=']) || value.contains(['\r', '\n']) {
                return None;
            }
            Some((name.to_string(), value.to_string()))
        })
        .collect::<Vec<_>>();
    pairs.sort_by(|left, right| left.0.cmp(&right.0));
    pairs
        .into_iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; ")
}

pub fn validation_request(cookie: &str, now: chrono::DateTime<Utc>) -> Result<(String, HeaderMap)> {
    if cookie.trim().is_empty() {
        bail!("Xueqiu cookie validation requires a non-empty cookie");
    }
    let begin = now
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc()
        .timestamp_millis()
        + 86_400_000;
    let mut url = Url::parse(KLINE_URL)?;
    url.query_pairs_mut().extend_pairs([
        ("symbol", "SH600519"),
        ("begin", &begin.to_string()),
        ("period", "day"),
        ("type", "before"),
        ("count", "-7500"),
        (
            "indicator",
            "kline,pe,pb,ps,pcf,market_capital,agt,ggt,balance",
        ),
    ]);
    let mut headers = HeaderMap::new();
    for (name, value) in [
        (
            "accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        ),
        ("accept-language", "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7"),
        ("cookie", cookie.trim()),
        ("referer", "https://xueqiu.com/"),
        ("user-agent", USER_AGENT),
        ("cache-control", "no-cache"),
        ("pragma", "no-cache"),
    ] {
        headers.insert(
            reqwest::header::HeaderName::from_bytes(name.as_bytes())?,
            reqwest::header::HeaderValue::from_str(value)?,
        );
    }
    Ok((url.to_string(), headers))
}

pub fn validate_payload(text: &str) -> Result<usize> {
    let body = crate::xueqiu::validate_body(text)?;
    let rows = body["data"]["item"]
        .as_array()
        .filter(|rows| !rows.is_empty())
        .context("Xueqiu cookie validation returned no K-line rows")?;
    Ok(rows.len())
}

async fn validate_candidate(state: &AppState, cookie: &str) -> Result<usize> {
    let (url, headers) = validation_request(cookie, Utc::now())?;
    let text = state
        .http
        .text(&url, Method::GET, headers, None)
        .await
        .context("Xueqiu cookie K-line validation failed")?;
    validate_payload(&text)
}

/// Read-only validation never opens Chrome or rewrites credentials.
pub async fn validate(state: &AppState) -> Result<Value> {
    let path = credential_path(state);
    let bytes = fs::read(&path).context("local Xueqiu credential store is unavailable")?;
    let stored: Value = serde_json::from_slice(&bytes)
        .context("local Xueqiu credential store contains invalid JSON")?;
    let cookie = stored["cookie"]
        .as_str()
        .map(str::trim)
        .filter(|cookie| !cookie.is_empty())
        .context("local Xueqiu credential store has no usable cookie")?;
    let count = validate_candidate(state, cookie).await?;
    Ok(
        json!({"source":"local-credential-store","cookieFingerprint":fingerprint(cookie),"validation":{"endpoint":"xueqiu-kline","rowCount":count},"writtenToDevVars":false,"writtenToWranglerVars":false,"localCredentialStore":path}),
    )
}

struct BrowserSession {
    child: Option<Child>,
    profile: Option<TempDir>,
}

impl BrowserSession {
    async fn close(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
        }
        self.child = None;
        self.profile = None;
    }
}

async fn cdp_ready(client: &Client, endpoint: &Url) -> bool {
    let Ok(url) = endpoint.join("/json/version") else {
        return false;
    };
    client
        .get(url)
        .send()
        .await
        .is_ok_and(|response| response.status().is_success())
}

async fn open_session(state: &AppState, client: &Client, endpoint: &Url) -> Result<BrowserSession> {
    if cdp_ready(client, endpoint).await {
        return Ok(BrowserSession {
            child: None,
            profile: None,
        });
    }
    let profile = tempfile::Builder::new()
        .prefix("stock-info-xueqiu-cdp-")
        .tempdir()?;
    let configured = state.setting("XUEQIU_CHROME_PATH");
    let executable = if configured.trim().is_empty() {
        if cfg!(target_os = "macos") {
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        } else {
            "google-chrome"
        }
    } else {
        configured.as_str()
    };
    let mut command = Command::new(executable);
    command
        .args([
            format!(
                "--remote-debugging-port={}",
                endpoint.port().unwrap_or(9222)
            ),
            "--remote-debugging-address=127.0.0.1".into(),
            "--remote-allow-origins=*".into(),
            format!("--user-data-dir={}", profile.path().display()),
            "--disable-blink-features=AutomationControlled".into(),
            "--disable-dev-shm-usage".into(),
            "--lang=zh-CN,zh;q=0.9,en;q=0.8".into(),
            "--window-size=1440,900".into(),
            "--no-first-run".into(),
            "--no-default-browser-check".into(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if state.setting("XUEQIU_CHROME_HEADLESS") == "1" {
        command.arg("--headless=new");
    }
    let child = command
        .spawn()
        .context("could not start isolated Chrome for Xueqiu CDP")?;
    let mut session = BrowserSession {
        child: Some(child),
        profile: Some(profile),
    };
    for _ in 0..30 {
        if cdp_ready(client, endpoint).await {
            return Ok(session);
        }
        if session.child.as_mut().unwrap().try_wait()?.is_some() {
            session.close().await;
            bail!("Chrome exited before local CDP became ready");
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    session.close().await;
    bail!("timed out waiting for local Chrome CDP")
}

struct CdpConnection {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    sequence: u64,
}

impl CdpConnection {
    async fn connect(url: &str) -> Result<Self> {
        local_endpoint(url, true)?;
        let (socket, _) = tokio::time::timeout(Duration::from_secs(10), connect_async(url))
            .await
            .context("CDP WebSocket connection timed out")??;
        Ok(Self {
            socket,
            sequence: 0,
        })
    }

    async fn command(&mut self, method: &str, params: Value) -> Result<Value> {
        self.sequence += 1;
        let id = self.sequence;
        self.socket
            .send(Message::Text(
                json!({"id":id,"method":method,"params":params})
                    .to_string()
                    .into(),
            ))
            .await?;
        tokio::time::timeout(Duration::from_secs(15), async {
            while let Some(message) = self.socket.next().await {
                let message = message?;
                if !message.is_text() {
                    continue;
                }
                let payload: Value = serde_json::from_str(message.to_text()?)?;
                if payload["id"].as_u64() != Some(id) {
                    continue;
                }
                if payload.get("error").is_some() {
                    bail!("CDP command rejected: {method}");
                }
                return Ok(payload.get("result").cloned().unwrap_or_else(|| json!({})));
            }
            bail!("CDP WebSocket closed during {method}")
        })
        .await
        .context("CDP command timed out")?
    }
}

async fn fetch_candidate(
    state: &AppState,
    client: &Client,
    endpoint: &Url,
) -> Result<(String, usize)> {
    let new_url = endpoint.join("/json/new?about:blank")?;
    let target: Value = client
        .put(new_url)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let result = async {
        let websocket = target["webSocketDebuggerUrl"]
            .as_str()
            .context("CDP target did not provide a debugger WebSocket URL")?;
        let mut cdp = CdpConnection::connect(websocket).await?;
        let result = async {
            cdp.command("Network.enable",json!({})).await?;
            cdp.command("Page.enable",json!({})).await?;
            cdp.command("Emulation.setTimezoneOverride",json!({"timezoneId":"Asia/Shanghai"})).await?;
            cdp.command("Network.setExtraHTTPHeaders",json!({"headers":{"Accept-Language":"zh-CN,zh;q=0.9,en;q=0.8"}})).await?;
            let navigation = cdp.command("Page.navigate",json!({"url":PAGE_URL})).await?;
            if navigation.get("errorText").is_some() {bail!("CDP Xueqiu navigation failed");}
            let ready_deadline = tokio::time::Instant::now()+Duration::from_secs(60);
            loop {
                let evaluated = cdp.command("Runtime.evaluate",json!({"expression":"Boolean(document.body)","returnByValue":true})).await?;
                if evaluated["result"]["value"]==true {break;}
                if tokio::time::Instant::now()>=ready_deadline {bail!("timed out waiting for Xueqiu document body");}
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            let deadline = tokio::time::Instant::now()+Duration::from_secs(60);
            let mut last_cookie = String::new();
            let mut last_at = None;
            loop {
                // API-scoped cookies only: a host-only www.xueqiu.com cookie
                // must never be sent to stock.xueqiu.com.
                let result = cdp.command("Network.getCookies",json!({"urls":[KLINE_URL]})).await?;
                let cookie = cookie_header_from_cdp(&result["cookies"]);
                let should_validate = last_at.is_none_or(|last: tokio::time::Instant|last.elapsed()>=Duration::from_secs(10)) || cookie!=last_cookie;
                if !cookie.is_empty() && should_validate {
                    last_cookie = cookie.clone();
                    last_at = Some(tokio::time::Instant::now());
                    if let Ok(count) = validate_candidate(state,&cookie).await {return Ok((cookie,count));}
                }
                if tokio::time::Instant::now()>=deadline {bail!("CDP Xueqiu anonymous K-line session was not usable within 60 seconds; refresh requires a valid API-scoped browser session");}
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }.await;
        let _ = cdp.socket.close(None).await;
        result
    }.await;
    // Close only the target created here, never a pre-existing browser/tab.
    if let Some(id) = target["id"].as_str()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        let _ = client
            .get(endpoint.join(&format!("/json/close/{id}"))?)
            .send()
            .await;
    }
    result
}

fn dev_vars(text: &str, cookie: &str) -> Result<String> {
    let replacement = format!("XUEQIU_COOKIE={}", serde_json::to_string(cookie)?);
    let mut found = false;
    let mut lines = Vec::new();
    for line in text.lines() {
        if line.starts_with("XUEQIU_COOKIE=") {
            if !found {
                lines.push(replacement.clone());
                found = true;
            }
        } else {
            lines.push(line.to_string());
        }
    }
    if !found {
        lines.push(replacement);
    }
    Ok(lines.join("\n") + "\n")
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("credential path has no parent")?;
    fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

fn optional_read(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn persist_validated(root: &Path, store: &Path, cookie: &str) -> Result<()> {
    // Called only after successful provider validation. Stage both old values
    // before changing either file; on a failed second replacement restore the
    // original store rather than leaving a half-updated local credential pair.
    let vars = root.join(".dev.vars");
    if store == vars
        || matches!((store.canonicalize(),vars.canonicalize()),(Ok(left),Ok(right)) if left==right)
    {
        bail!("Xueqiu credential store and .dev.vars must be distinct files");
    }
    let previous_store = optional_read(store)?;
    let previous_vars = optional_read(&vars)?;
    let vars_text = previous_vars
        .as_deref()
        .map(std::str::from_utf8)
        .transpose()?
        .unwrap_or("");
    let next_vars = dev_vars(vars_text, cookie)?;
    let payload =
        serde_json::to_vec(&json!({"cookie":cookie,"updatedAt":Utc::now().timestamp_millis()}))?;
    atomic_write(store, &payload)?;
    if let Err(error) = atomic_write(&vars, next_vars.as_bytes()) {
        let restore = if let Some(previous) = previous_store {
            atomic_write(store, &previous)
        } else {
            fs::remove_file(store).map_err(Into::into)
        };
        if restore.is_err() {
            bail!(
                "local credential pair write failed and credential-store rollback failed; inspect local file permissions"
            );
        }
        return Err(
            error.context("local credential pair write failed; previous credential store restored")
        );
    }
    Ok(())
}

/// Serialized process-local refresh. Existing cookies are not changed when CDP
/// or the same-provider validation fails; the result never includes a secret.
pub async fn refresh(state: &AppState) -> Result<Value> {
    static REFRESH: OnceLock<Mutex<()>> = OnceLock::new();
    let _refresh = REFRESH.get_or_init(|| Mutex::new(())).lock().await;
    let configured = state.setting("XUEQIU_CDP_URL");
    let endpoint = local_endpoint(
        if configured.trim().is_empty() {
            "http://127.0.0.1:9222"
        } else {
            configured.trim()
        },
        false,
    )?;
    let client = Client::builder()
        .no_proxy()
        .timeout(Duration::from_millis(1500))
        .build()?;
    let mut browser = open_session(state, &client, &endpoint).await?;
    let outcome = fetch_candidate(state, &client, &endpoint).await;
    browser.close().await;
    let (cookie, count) = outcome?;
    let root = state.root.clone();
    let path = credential_path(state);
    let stored_path = path.clone();
    let safe_fingerprint = fingerprint(&cookie);
    tokio::task::spawn_blocking(move || persist_validated(&root, &path, &cookie)).await??;
    Ok(
        json!({"source":"cdp","cookieFingerprint":safe_fingerprint,"validation":{"endpoint":"xueqiu-kline","rowCount":count},"writtenToDevVars":true,"writtenToWranglerVars":false,"localCredentialStore":stored_path,"updatedAt":Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true)}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn api_cookie_scope_rejects_suffix_lookalikes_and_header_injection() {
        let cookie = cookie_header_from_cdp(&json!([
            {"name":"z","value":"2","domain":".xueqiu.com"},
            {"name":"a","value":"1","domain":"stock.xueqiu.com"},
            {"name":"bad","value":"secret","domain":"evilxueqiu.com"},
            {"name":"bad\r\n","value":"secret","domain":"xueqiu.com"},
            {"name":"bad-value","value":"secret\r\n","domain":"xueqiu.com"},
            {"name":"bad-separator","value":"secret; injected=true","domain":"xueqiu.com"},
            {"name":"missing-value","domain":"xueqiu.com"}
        ]));
        assert_eq!(cookie, "a=1; z=2");
        for endpoint in [
            "https://127.0.0.1:9222",
            "http://evil.example:9222",
            "http://secret@localhost:9222",
        ] {
            assert!(local_endpoint(endpoint, false).is_err());
        }
        assert!(local_endpoint("http://127.0.0.1:9222", false).is_ok());
    }
    #[test]
    fn validation_uses_real_kline_profile_and_rejects_empty_or_denied_results() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-29T01:02:03Z")
            .unwrap()
            .with_timezone(&Utc);
        let (url, headers) = validation_request("fixture-cookie", now).unwrap();
        let url = Url::parse(&url).unwrap();
        let params = url
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(url.host_str(), Some("stock.xueqiu.com"));
        assert_eq!(params["symbol"], "SH600519");
        assert_eq!(params["type"], "before");
        assert_eq!(headers["cookie"], "fixture-cookie");
        for payload in [
            "{\"error_code\":400016}",
            "{\"data\":{\"item\":[]}}",
            "<html>blocked</html>",
        ] {
            assert!(validate_payload(payload).is_err());
        }
        assert_eq!(validate_payload("{\"data\":{\"item\":[[1]]}}").unwrap(), 1);
    }
    #[test]
    fn validated_persistence_is_private_atomic_and_preserves_other_dev_vars() {
        let root = tempfile::tempdir().unwrap();
        fs::write(
            root.path().join(".dev.vars"),
            "OTHER=keep\nXUEQIU_COOKIE=\"old\"\n",
        )
        .unwrap();
        let store = root.path().join("runtime/credential.json");
        persist_validated(root.path(), &store, "new-cookie").unwrap();
        let vars = fs::read_to_string(root.path().join(".dev.vars")).unwrap();
        assert_eq!(vars, "OTHER=keep\nXUEQIU_COOKIE=\"new-cookie\"\n");
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(&store).unwrap()).unwrap()["cookie"],
            "new-cookie"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&store).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(root.path().join(".dev.vars"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        assert_eq!(fingerprint("new-cookie").len(), 16);
    }

    #[test]
    fn credential_pair_cannot_alias_the_environment_file() {
        let root = tempfile::tempdir().unwrap();
        let vars = root.path().join(".dev.vars");
        fs::write(&vars, "OTHER=untouched\nXUEQIU_COOKIE=\"old\"\n").unwrap();
        assert!(persist_validated(root.path(), &vars, "new").is_err());
        assert_eq!(
            fs::read_to_string(&vars).unwrap(),
            "OTHER=untouched\nXUEQIU_COOKIE=\"old\"\n"
        );
    }
}
