//! Axum HTTP API over `file-core`.
//!
//! Jobs are asynchronous: `POST /api/v1/jobs` uploads files and returns an id,
//! the client polls `GET /api/v1/jobs/{id}`, then downloads the result.
//! By default only loopback binding is allowed (the desktop app); a hosted server uses signed visitor sessions instead
//! (see [`config::AuthMode`]) and may bind any address.

mod access;
mod config;
mod docs;
mod error;
mod jobs;
mod middleware;
mod pdf_routes;
mod principal;
mod quota;
mod routes;
mod session_routes;
pub mod types;

pub use config::{generate_token, ApiConfig, AuthMode, TierLimits, Captcha};
pub use principal::{Principal, Tier};

use axum::extract::DefaultBodyLimit;
use axum::routing::{get, post};
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use axum::{middleware as mw, Router};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

pub struct Shared {
    pub(crate) cfg: ApiConfig,
    pub(crate) store: jobs::Store,
    pub(crate) docs: docs::DocStore,
    pub(crate) allowed_hosts: Vec<String>,
    pub(crate) registry: Arc<file_core::Registry>,
    pub(crate) quota: quota::Quota,
    pub(crate) access: access::Access,
}

pub type AppState = Arc<Shared>;

async fn api_not_found() -> ApiErrorResponse {
    ApiErrorResponse(error::ApiError::from_status(axum::http::StatusCode::NOT_FOUND))
}
struct ApiErrorResponse(error::ApiError);
impl axum::response::IntoResponse for ApiErrorResponse {
    fn into_response(self) -> axum::response::Response {
        self.0.into_response()
    }
}

fn router(state: AppState) -> Router {
    let api = Router::new()
        .route("/jobs", post(routes::create_job).layer(DefaultBodyLimit::max((state.cfg.max_request_bytes + 1024 * 1024) as usize)))
        .route("/capabilities", get(routes::capabilities))
        .route("/me", get(session_routes::me))
        .route("/jobs/preview", post(routes::preview))
        .route("/jobs/{id}", get(routes::get_job).delete(routes::cancel_job))
        .route("/jobs/{id}/cancel", post(routes::cancel_job))
        .route("/jobs/{id}/link", post(session_routes::make_link))
        .route("/jobs/{id}/result", get(routes::get_result))
        .route("/jobs/{id}/result/files", get(routes::list_result))
        .route("/jobs/{id}/result/files/{index}", get(routes::get_result_file))
        .route(
            "/pdf/documents",
            post(pdf_routes::open_document).layer(DefaultBodyLimit::max((state.cfg.max_file_bytes + 1024 * 1024) as usize)),
        )
        .route("/pdf/documents/{id}", get(pdf_routes::get_document).delete(pdf_routes::close_document))
        .route("/pdf/documents/{id}/pages/{n}/image", get(pdf_routes::page_image))
        .fallback(api_not_found)
        .layer(mw::from_fn_with_state(state.clone(), middleware::require_bearer));

    // Things that carry their own proof instead of a bearer token: the signed download link, and asking for a session.
    let mut open = Router::new().route("/dl/{id}/{which}", get(session_routes::download));
    if matches!(state.cfg.auth, AuthMode::Sessions { .. }) {
        open = open.route("/session", post(session_routes::create_session));
    }

    let mut app = Router::new().route("/health", get(routes::health)).nest("/api/v1", open.merge(api));

    // The web app itself, when this server is also its host. Unknown paths get the app (it has its own routes), except the API's.
    if let Some(dir) = &state.cfg.static_dir {
        app = app
            .fallback_service(ServeDir::new(dir).fallback(ServeFile::new(dir.join("index.html"))))
            .layer(mw::from_fn(middleware::page_security_headers));
    }
    let app = app
        .layer(mw::from_fn_with_state(state.clone(), middleware::check_origin_and_host))
        .layer(mw::from_fn(middleware::request_context));

    // Another site's page may use the API only if it is on the list. The browser asks first (a preflight), which is answered here,
    // before any authentication, and answered only for listed origins.
    let origins: Vec<axum::http::HeaderValue> = state.cfg.allowed_origins.iter().filter_map(|o| o.parse().ok()).collect();
    let app = if origins.is_empty() {
        app
    } else {
        use axum::http::{header, Method};
        app.layer(
            CorsLayer::new()
                .allow_origin(origins)
                .allow_methods([Method::GET, Method::POST, Method::DELETE])
                .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE, header::HeaderName::from_static(session_routes::CAPTCHA_HEADER)])
                .expose_headers([header::CONTENT_DISPOSITION, header::HeaderName::from_static("x-request-id")])
                .max_age(Duration::from_secs(600)),
        )
    };
    app.with_state(state)
}

pub struct RunningServer {
    pub addr: SocketAddr,
    pub token: String,
    state: AppState,
    stop: tokio::sync::watch::Sender<bool>,
    server: tokio::task::JoinHandle<()>,
    sweeper: tokio::task::JoinHandle<()>,
}

impl RunningServer {
    pub fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// Stop serving, cancel running jobs and delete every job directory.
    pub async fn shutdown(self) {
        let _ = self.stop.send(true);
        if tokio::time::timeout(Duration::from_secs(3), self.server).await.is_err() {
            tracing::warn!("server did not stop in time");
        }
        let _ = self.sweeper.await;
        for dir in self.state.store.drain().into_iter().chain(self.state.docs.drain()) {
            let _ = tokio::fs::remove_dir_all(dir).await;
        }
    }
}

/// Remove job directories left behind by a crashed run. Only touches `job_*`.
fn clean_stale(data_dir: &std::path::Path) {
    if let Ok(rd) = std::fs::read_dir(data_dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with("job_") || name.starts_with("doc_") {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
}

pub async fn start(cfg: ApiConfig) -> std::io::Result<RunningServer> {
    start_with(cfg, file_core::engine::global().clone()).await
}

/// Start the server on a specific engine registry (tests inject fake engines).
pub async fn start_with(cfg: ApiConfig, registry: Arc<file_core::Registry>) -> std::io::Result<RunningServer> {
    cfg.validate()?;
    std::fs::create_dir_all(&cfg.data_dir)?;
    clean_stale(&cfg.data_dir);

    let listener = tokio::net::TcpListener::bind(cfg.bind).await?;
    let addr = listener.local_addr()?;
    let port = addr.port();
    let mut allowed_hosts = vec![format!("127.0.0.1:{port}"), format!("localhost:{port}"), format!("[::1]:{port}")];
    allowed_hosts.extend(cfg.allowed_hosts.iter().cloned());

    let token = cfg.token.clone();
    let retention = cfg.retention;
    let sweep_every = cfg.sweep_interval;
    let idle = cfg.document_idle;
    let state: AppState =
        Arc::new(Shared { store: jobs::Store::new(&cfg, registry.clone()), docs: docs::DocStore::new(cfg.max_open_documents),
        access: match &cfg.auth {
            AuthMode::Sessions { secret, ttl } => access::Access::new(secret, *ttl),
            AuthMode::LocalToken => access::Access::random(),
        },
        cfg,
        allowed_hosts,
        registry,
        quota: Default::default(),
    });
    let (stop, mut stop_rx) = tokio::sync::watch::channel(false);

    let app = router(state.clone());
    let mut srx = stop_rx.clone();
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>())
            .with_graceful_shutdown(async move {
                let _ = srx.wait_for(|v| *v).await;
            })
            .await;
    });

    let st = state.clone();
    let sweeper = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = tokio::time::sleep(sweep_every) => {}
                _ = stop_rx.wait_for(|v| *v) => break,
            }
            for dir in st.store.take_expired(retention).into_iter().chain(st.docs.take_idle(idle)) {
                let _ = tokio::fs::remove_dir_all(dir).await;
            }
            st.quota.prune();
        }
    });

    Ok(RunningServer { addr, token, state, stop, server, sweeper })
}
