pub mod analysis_cli;
pub mod cache_policy;
pub mod codes;
pub mod company;
pub mod cookie_refresh;
pub mod coverage;
pub mod dashboard;
pub mod db;
pub mod eastmoney;
pub mod featured_reports;
pub mod featured_workflow;
pub mod feed_processing;
pub mod finance;
mod follow;
pub mod fund;
pub mod http;
pub mod knowledge;
pub mod macro_data;
pub mod maintenance;
pub mod market;
pub mod observation;
pub mod options;
pub mod portfolio;
pub mod research;
pub mod research_cli;
pub mod retired_selftest_bridge;
pub mod runtime_jobs;
pub mod scheduler;
pub mod storage;
pub mod sync_cli;
pub mod thirteenf;
pub mod xueqiu;

use axum::{
    Json, Router,
    extract::{Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{any, get},
};
use chrono::Utc;
use serde_json::{Value, json};
use std::path::Path;
use tower_http::services::{ServeDir, ServeFile};

#[derive(Clone)]
pub struct AppState {
    pub db: db::Database,
    pub version: String,
    pub authority: String,
    pub root: std::path::PathBuf,
    pub http: http::HttpClient,
    pub tasks: tokio_util::task::TaskTracker,
}

impl AppState {
    pub fn new(
        db: db::Database,
        root: std::path::PathBuf,
        authority: String,
    ) -> anyhow::Result<Self> {
        Ok(Self {
            db,
            root,
            authority,
            version: http::setting("APP_VERSION"),
            http: http::HttpClient::new()?,
            tasks: tokio_util::task::TaskTracker::new(),
        })
    }
    pub fn setting(&self, key: &str) -> String {
        if key == "APP_RUNTIME" {
            return "rust".into();
        }
        http::setting(key)
    }
    pub fn spawn<F>(&self, future: F) -> tokio::task::JoinHandle<F::Output>
    where
        F: std::future::Future + Send + 'static,
        F::Output: Send + 'static,
    {
        self.tasks.spawn(future)
    }
    pub fn config(&self, relative: &str) -> anyhow::Result<Value> {
        Ok(serde_json::from_slice(&std::fs::read(
            self.root.join(relative),
        )?)?)
    }
    pub fn data_dir(&self) -> std::path::PathBuf {
        let path = self.setting("LOCAL_DATA_DIR");
        self.root
            .join(if path.is_empty() { "data/local" } else { &path })
    }
    pub fn market_store(&self) -> anyhow::Result<storage::ObjectStore> {
        let configured = self.setting("LOCAL_MARKET_DATA_DIR");
        storage::ObjectStore::new(if configured.is_empty() {
            self.data_dir().join("market-data")
        } else {
            self.root.join(configured)
        })
    }
    pub fn knowledge_store(&self) -> anyhow::Result<storage::ObjectStore> {
        let configured = self.setting("KNOWLEDGE_CONTENT_LOCAL_DIR");
        storage::ObjectStore::new(if configured.is_empty() {
            self.data_dir().join("knowledge-content")
        } else {
            self.root.join(configured)
        })
    }
}

#[derive(Debug)]
pub struct ApiError(pub StatusCode, pub String);
pub type ApiResult = Result<Json<Value>, ApiError>;

impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        // Diagnostics stay local; SQL, filesystem paths and private values
        // must not be exposed in an API error body.
        eprintln!("stock-info: {error:#}");
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal server error".into(),
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.0,
            Json(json!({"code": self.0.as_u16(), "msg": self.1, "data": null})),
        )
            .into_response()
    }
}

pub fn ok(data: Value) -> Json<Value> {
    Json(json!({"code": 200, "msg": "OK", "data": data}))
}

pub fn router(state: AppState, assets: &Path) -> Router {
    let api = Router::new()
        .merge(market::routes())
        .merge(knowledge::routes())
        .merge(research::routes())
        .merge(runtime_jobs::routes())
        .merge(company::routes())
        .merge(fund::routes())
        .merge(featured_reports::routes())
        .merge(dashboard::routes())
        .merge(observation::routes())
        .merge(portfolio::routes())
        .merge(macro_data::routes())
        .merge(finance::routes())
        .merge(options::routes())
        .merge(thirteenf::routes())
        .route(
            "/auth/{*path}",
            any(|| async {
                ApiError(
                    StatusCode::NOT_FOUND,
                    "authentication is not available in the local runtime".into(),
                )
            }),
        )
        .route("/llm-tasks", any(retired_scheduler))
        .route("/llm-tasks/{*path}", any(retired_scheduler))
        .route("/health", get(health))
        .route(
            "/companies/follow/forecast",
            get(follow::read).post(follow::write),
        )
        .fallback(api_not_found);
    Router::new()
        .merge(featured_reports::page_routes())
        .merge(knowledge::content_routes())
        .nest("/api", api)
        .route(
            "/",
            axum::routing::get_service(ServeFile::new(assets.join("home.html"))),
        )
        .route(
            "/home.html",
            get(|| async { (StatusCode::MOVED_PERMANENTLY, [(header::LOCATION, "/")]) }),
        )
        .route(
            "/login.html",
            any(|| async {
                ApiError(
                    StatusCode::NOT_FOUND,
                    "local runtime has no login surface".into(),
                )
            }),
        )
        .fallback_service(ServeDir::new(assets).append_index_html_on_directories(false))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            local_boundary,
        ))
        .with_state(state)
}

/// Legacy content URLs remain reachable on a second loopback listener. Only
/// the corresponding local API origin may read them cross-port; APIs and
/// private ledgers are never mounted here.
pub fn content_router(state: AppState, api_authority: String) -> Router {
    let boundary = ContentBoundary {
        content_authority: state.authority.clone(),
        api_authority,
    };
    knowledge::content_routes()
        .route(
            "/knowledge-content/{*key}",
            axum::routing::options(|| async { StatusCode::NO_CONTENT }),
        )
        .route(
            "/featured-reports/{*key}",
            axum::routing::options(|| async { StatusCode::NO_CONTENT }),
        )
        .layer(middleware::from_fn_with_state(boundary, content_boundary))
        .with_state(state)
}

#[derive(Clone)]
struct ContentBoundary {
    content_authority: String,
    api_authority: String,
}

async fn content_boundary(
    State(boundary): State<ContentBoundary>,
    request: Request,
    next: Next,
) -> Response {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !allowed_authority(host, &boundary.content_authority) {
        return ApiError(StatusCode::FORBIDDEN, "loopback Host required".into()).into_response();
    }
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let mut cross_port = false;
    if let Some(origin) = &origin {
        if origin != &format!("http://{host}") {
            let accepted = origin
                .strip_prefix("http://")
                .is_some_and(|authority| allowed_authority(authority, &boundary.api_authority));
            if !accepted
                || ![
                    axum::http::Method::GET,
                    axum::http::Method::HEAD,
                    axum::http::Method::OPTIONS,
                ]
                .contains(request.method())
            {
                return ApiError(
                    StatusCode::FORBIDDEN,
                    "local same-origin content access required".into(),
                )
                .into_response();
            }
            cross_port = true;
        }
    } else if request
        .headers()
        .get("sec-fetch-site")
        .is_some_and(|v| v == "cross-site")
    {
        return ApiError(
            StatusCode::FORBIDDEN,
            "cross-site content access denied".into(),
        )
        .into_response();
    }
    let mut response = next.run(request).await;
    if cross_port {
        let headers = response.headers_mut();
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            origin.unwrap().parse().unwrap(),
        );
        headers.insert(header::VARY, "Origin".parse().unwrap());
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            "GET, HEAD, OPTIONS".parse().unwrap(),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            "Range".parse().unwrap(),
        );
        headers.insert(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "Content-Length, Content-Range, Accept-Ranges"
                .parse()
                .unwrap(),
        );
    }
    response
}

async fn health(State(state): State<AppState>) -> ApiResult {
    let healthy = state
        .db
        .run(|conn| Ok(conn.query_row("SELECT 1", [], |row| row.get::<_, i32>(0))? == 1))
        .await?;
    Ok(ok(json!({"name": "stock-info", "version": state.version,
        "runtime": "rust", "sqlite": healthy, "d1": healthy,
        "time": Utc::now().to_rfc3339()})))
}

async fn api_not_found() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "not found".into())
}

async fn retired_scheduler() -> ApiError {
    ApiError(
        StatusCode::GONE,
        "local generic LLM scheduler was removed; use a direct business operation or taskd".into(),
    )
}

/// Binding loopback is not enough: reject DNS-rebinding Host headers and
/// cross-origin requests (including reads of private records). No wildcard CORS.
async fn local_boundary(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if !local_headers(request.headers(), &state.authority) {
        return ApiError(
            StatusCode::FORBIDDEN,
            "loopback Host and same-origin access required".into(),
        )
        .into_response();
    }
    let mut response = next.run(request).await;
    if response
        .headers()
        .get(header::CONTENT_TYPE)
        .is_some_and(|v| v.as_bytes().starts_with(b"application/json"))
    {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    }
    response
}

fn local_headers(headers: &HeaderMap, expected: &str) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    if !allowed_authority(host, expected) {
        return false;
    }
    if headers
        .get("sec-fetch-site")
        .is_some_and(|v| v != "same-origin" && v != "none")
    {
        return false;
    }
    if let Some(origin) = headers.get(header::ORIGIN) {
        return origin.to_str().is_ok_and(|v| v == format!("http://{host}"));
    }
    true
}

fn allowed_authority(host: &str, expected: &str) -> bool {
    use axum::http::uri::Authority;
    let Ok(host) = host.parse::<Authority>() else {
        return false;
    };
    let Ok(expected) = expected.parse::<Authority>() else {
        return false;
    };
    ["127.0.0.1", "localhost", "[::1]"].contains(&host.host())
        && host.port_u16() == expected.port_u16()
}
