use crate::error::{ApiError, REQUEST_ID};
use crate::AppState;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, HeaderValue};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use std::net::{IpAddr, SocketAddr};
use subtle::ConstantTimeEq;

/// Outermost layer: request id, JSON-ify framework errors, one log line.
pub async fn request_context(req: Request, next: Next) -> Response {
    let id = format!("req_{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
    let method = req.method().clone();
    let path = req.uri().path().to_string(); // path only: never the query, headers or body
    REQUEST_ID
        .scope(id.clone(), async move {
            let mut res = next.run(req).await;
            let status = res.status();
            // Nothing the API says is worth keeping in a cache.
            if path.starts_with("/api") && !res.headers().contains_key(header::CACHE_CONTROL) {
                res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            }
            let is_json = res
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.starts_with("application/json"));
            if (status.is_client_error() || status.is_server_error()) && !is_json {
                res = ApiError::from_status(status).into_response();
            }
            if let Ok(v) = HeaderValue::from_str(&id) {
                res.headers_mut().insert("x-request-id", v);
            }
            tracing::info!(request_id = %id, %method, %path, status = res.status().as_u16(), "request");
            res
        })
        .await
}

/// The address a request really came from. Behind a proxy that is whatever the proxy writes in `client_ip_header`
/// (`fly-client-ip`, or the last entry of `x-forwarded-for`, which is the one our own proxy appended). If that header is
/// missing or unreadable the peer address is used instead: everyone then shares the proxy's address, which limits too much
/// rather than too little.
pub fn client_ip(cfg: &crate::ApiConfig, headers: &axum::http::HeaderMap, peer: Option<SocketAddr>) -> Option<IpAddr> {
    if let Some(name) = &cfg.client_ip_header {
        if let Some(value) = headers.get(name.as_str()).and_then(|v| v.to_str().ok()) {
            let candidate = if name.eq_ignore_ascii_case("x-forwarded-for") { value.rsplit(',').next() } else { value.split(',').next() };
            if let Some(ip) = candidate.and_then(|c| c.trim().parse().ok()) {
                return Some(ip);
            }
        }
    }
    peer.map(|p| p.ip())
}

fn same_origin(origin: &str, host: Option<&str>) -> bool {
    let Some(host) = host else { return false };
    origin.split_once("://").is_some_and(|(_, rest)| rest.eq_ignore_ascii_case(host))
}

/// Refuse other web pages and DNS rebinding: an Origin header must be allow-listed (or be this very server's own page),
/// and the Host must be one of our names. On a hosted server `/health` is open to any Host so the platform's health checks can reach it.
pub async fn check_origin_and_host(State(st): State<AppState>, req: Request, next: Next) -> Result<Response, ApiError> {
    let host = req.headers().get(header::HOST).and_then(|h| h.to_str().ok());
    if let Some(origin) = req.headers().get(header::ORIGIN) {
        let ok = origin.to_str().is_ok_and(|o| st.cfg.allowed_origins.iter().any(|a| a == o) || same_origin(o, host));
        if !ok {
            return Err(ApiError::forbidden("FORBIDDEN_ORIGIN", "Requests from other web pages are not allowed."));
        }
    }
    let host_ok = host.is_some_and(|h| st.allowed_hosts.iter().any(|a| a.eq_ignore_ascii_case(h)));
    // A hosting platform's health checker may not know our host name. Only a hosted server makes that exception;
    // the desktop engine keeps its guard against DNS rebinding on every path.
    let open_health = req.uri().path() == "/health" && matches!(st.cfg.auth, crate::config::AuthMode::Sessions { .. });
    if !host_ok && !open_health {
        return Err(ApiError::forbidden("FORBIDDEN_HOST", "Unexpected host name."));
    }
    Ok(next.run(req).await)
}

/// Who is calling: the desktop's one token, or a hosted visitor's signed session.
pub async fn require_bearer(State(st): State<AppState>, mut req: Request, next: Next) -> Result<Response, ApiError> {
    let presented = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("")
        .to_string();
    let who = match &st.cfg.auth {
        crate::config::AuthMode::LocalToken => {
            let ok: bool = presented.as_bytes().ct_eq(st.cfg.token.as_bytes()).into();
            if !ok {
                return Err(ApiError::unauthorized());
            }
            crate::principal::Principal::local()
        }
        crate::config::AuthMode::Sessions { .. } => {
            let id = st.access.session_id(&presented).ok_or_else(ApiError::unauthorized)?;
            let peer = req.extensions().get::<ConnectInfo<SocketAddr>>().map(|c| c.0);
            crate::principal::Principal { id, tier: crate::principal::Tier::Anonymous, ip: client_ip(&st.cfg, req.headers(), peer) }
        }
    };
    req.extensions_mut().insert(who);
    Ok(next.run(req).await)
}

/// Headers for the web app's own pages (not the API): no framing, no sniffing, and a policy that lets the page talk only to itself.
pub async fn page_security_headers(req: Request, next: Next) -> Response {
    let is_api = req.uri().path().starts_with("/api") || req.uri().path() == "/health";
    let mut res = next.run(req).await;
    if !is_api {
        let h = res.headers_mut();
        for (k, v) in [
            ("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"),
            ("x-content-type-options", "nosniff"),
            ("x-frame-options", "DENY"),
            ("referrer-policy", "no-referrer"),
            ("permissions-policy", "camera=(), microphone=(), geolocation=()"),
        ] {
            h.insert(header::HeaderName::from_static(k), HeaderValue::from_static(v));
        }
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderMap;

    fn cfg(header: Option<&str>) -> crate::ApiConfig {
        let mut c = crate::ApiConfig::local(std::env::temp_dir());
        c.client_ip_header = header.map(String::from);
        c
    }
    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(), v.parse().unwrap());
        }
        h
    }
    const PEER: Option<SocketAddr> = Some(SocketAddr::new(IpAddr::V4(std::net::Ipv4Addr::new(10, 0, 0, 7)), 1234));

    #[test]
    fn the_address_comes_from_the_trusted_header_or_the_peer() {
        let ip = |s: &str| s.parse::<IpAddr>().ok();
        assert_eq!(client_ip(&cfg(None), &headers(&[("fly-client-ip", "1.2.3.4")]), PEER), ip("10.0.0.7"), "no header configured: a header is never believed");
        assert_eq!(client_ip(&cfg(Some("fly-client-ip")), &headers(&[("fly-client-ip", "1.2.3.4")]), PEER), ip("1.2.3.4"));
        assert_eq!(client_ip(&cfg(Some("fly-client-ip")), &headers(&[("fly-client-ip", "2001:db8::1")]), PEER), ip("2001:db8::1"));
        assert_eq!(client_ip(&cfg(Some("fly-client-ip")), &headers(&[]), PEER), ip("10.0.0.7"), "missing: the peer");
        assert_eq!(client_ip(&cfg(Some("fly-client-ip")), &headers(&[("fly-client-ip", "not an address")]), PEER), ip("10.0.0.7"), "garbled: the peer");
        // x-forwarded-for: the entry our own proxy appended (the last) counts; whatever the visitor put before it doesn't
        assert_eq!(client_ip(&cfg(Some("x-forwarded-for")), &headers(&[("x-forwarded-for", "6.6.6.6, 1.2.3.4")]), PEER), ip("1.2.3.4"));
    }

    #[test]
    fn same_origin_means_the_page_is_ours() {
        assert!(same_origin("https://orangefile.fly.dev", Some("orangefile.fly.dev")));
        assert!(same_origin("http://127.0.0.1:5173", Some("127.0.0.1:5173")));
        assert!(!same_origin("https://evil.example", Some("orangefile.fly.dev")));
        assert!(!same_origin("https://orangefile.fly.dev.evil.example", Some("orangefile.fly.dev")));
        assert!(!same_origin("https://orangefile.fly.dev", None));
        assert!(!same_origin("null", Some("null")));
    }
}
