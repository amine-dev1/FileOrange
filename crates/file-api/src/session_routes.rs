//! `POST /session`, `GET /me`, and signed download links.

use crate::access::Access;
use crate::error::ApiError;
use crate::middleware::client_ip;
use crate::principal::{Principal, Tier};
use crate::types::*;
use crate::{routes, AppState};
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use std::net::SocketAddr;

/// Header carrying the CAPTCHA answer when a new session is asked for.
pub const CAPTCHA_HEADER: &str = "x-turnstile-token";

/// `POST /session`: start (or, sending a still-valid token, extend) a visitor's session. No account, no password:
/// the token is just a signed id. Since anyone can ask for one, the real limits are per network address, and when a
/// CAPTCHA is configured a new session also needs a passed challenge (extending a valid one doesn't).
pub async fn create_session(State(st): State<AppState>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap) -> Result<Response, ApiError> {
    let presented = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "));
    let (id, fresh) = match presented.and_then(|t| st.access.session_id(t)) {
        Some(id) => (id, false),
        None => (Access::new_visitor_id(), true),
    };
    let ip = client_ip(&st.cfg, &headers, Some(peer));
    if fresh && !st.quota.allow_session(ip, st.cfg.session_mints_per_ip_per_hour) {
        return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "RATE_LIMITED", "Too many visits have started from your network. Try again in a little while."));
    }
    if fresh {
        if let Some(c) = &st.cfg.captcha {
            let answer = headers.get(CAPTCHA_HEADER).and_then(|v| v.to_str().ok()).filter(|t| !t.is_empty() && t.len() <= 2048);
            let Some(answer) = answer else {
                return Ok(captcha_needed(c, "CAPTCHA_REQUIRED", "Please confirm you're a person to continue."));
            };
            if !captcha_passes(c, answer, ip).await {
                return Ok(captcha_needed(c, "CAPTCHA_FAILED", "The check that you're a person didn't pass. Try again."));
            }
        }
    }
    let (token, expires_in) = st.access.session_token(&id);
    Ok(Json(SessionResponse { token, expires_in }).into_response())
}

/// 403 with what the browser needs to show the challenge.
fn captcha_needed(c: &crate::config::Captcha, code: &'static str, message: &str) -> Response {
    let body = serde_json::json!({
        "error": { "code": code, "message": message, "request_id": crate::error::current_request_id() },
        "captcha": { "provider": "turnstile", "site_key": c.site_key },
    });
    (StatusCode::FORBIDDEN, Json(body)).into_response()
}

/// Ask Cloudflare whether this answer is genuine. Anything other than a clear yes (including Cloudflare being
/// unreachable) counts as no: a new session is refused rather than handed out unchecked.
async fn captcha_passes(c: &crate::config::Captcha, answer: &str, ip: Option<std::net::IpAddr>) -> bool {
    static CLIENT: std::sync::OnceLock<Option<reqwest::Client>> = std::sync::OnceLock::new();
    let client = CLIENT.get_or_init(|| {
        reqwest::Client::builder().use_rustls_tls().timeout(std::time::Duration::from_secs(10)).build().ok()
    });
    let Some(client) = client else { return false };
    let mut form = vec![("secret", c.secret.clone()), ("response", answer.to_string())];
    if let Some(ip) = ip {
        form.push(("remoteip", ip.to_string()));
    }
    #[derive(serde::Deserialize)]
    struct Verdict {
        success: bool,
    }
    match client.post(&c.verify_url).form(&form).send().await {
        Ok(r) if r.status().is_success() => r.json::<Verdict>().await.map(|v| v.success).unwrap_or(false),
        Ok(r) => {
            tracing::warn!(status = %r.status(), "CAPTCHA check answered with an error");
            false
        }
        Err(e) => {
            tracing::warn!("CAPTCHA check failed: {e}");
            false
        }
    }
}

/// `GET /me`
pub async fn me(State(st): State<AppState>, Extension(who): Extension<Principal>) -> Json<MeResponse> {
    let l = st.cfg.limits_for(&who);
    let (bytes_today, jobs_this_hour) = st.quota.usage(&who);
    Json(MeResponse {
        tier: if who.tier == Tier::Local { "local" } else { "anonymous" }.into(),
        limits: MeLimits {
            max_file_bytes: l.max_file_bytes,
            max_request_bytes: l.max_request_bytes,
            max_files: l.max_files as u64,
            daily_bytes: l.daily_bytes,
            max_active_jobs: (l.max_active_jobs != usize::MAX).then_some(l.max_active_jobs as u64),
        },
        usage: MeUsage { bytes_today, jobs_this_hour },
    })
}

/// `POST /jobs/{id}/link`: a two-minute address for one result file (or the whole result). A plain link can't carry the
/// Authorization header a browser download would need, so the server signs one that proves the caller already had access.
pub async fn make_link(State(st): State<AppState>, Extension(who): Extension<Principal>, Path(id): Path<String>, body: Option<Json<LinkRequest>>) -> Result<Json<LinkResponse>, ApiError> {
    routes::ensure_completed(&st, &id, &who)?;
    let which = body.and_then(|b| b.0.index).map_or("all".to_string(), |i| i.to_string());
    let (exp, sig) = st.access.link(&id, &which);
    Ok(Json(LinkResponse { url: format!("/api/v1/dl/{id}/{which}?exp={exp}&sig={sig}"), expires_in: st.access.link_ttl.as_secs() }))
}

#[derive(serde::Deserialize)]
pub struct LinkQuery {
    exp: u64,
    sig: String,
}

/// `GET /dl/{id}/{which}`: no header needed, the signature is the proof.
pub async fn download(State(st): State<AppState>, Path((id, which)): Path<(String, String)>, Query(q): Query<LinkQuery>) -> Result<Response, ApiError> {
    if !st.access.verify_link(&id, &which, q.exp, &q.sig) {
        return Err(ApiError::forbidden("LINK_INVALID", "This download link has expired. Go back and press Download again."));
    }
    let rec = routes::completed_by_link(&st, &id)?;
    match which.as_str() {
        "all" => routes::bundle_response(&rec).await,
        n => routes::file_response(&rec, n.parse().map_err(|_| ApiError::invalid("Bad link."))?).await,
    }
}
