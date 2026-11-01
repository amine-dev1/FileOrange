//! Standalone server. Two modes:
//!
//! Local (default), for development and tests:
//!   FILE_API_TOKEN     bearer token (generated and printed if unset)
//!   FILE_API_BIND      loopback address, default 127.0.0.1:0
//!   FILE_API_DATA_DIR  job storage, default <tmp>/file-api
//!   ORANGEFILE_PDFIUM  folder with the PDFium library (debug builds)
//!
//! Hosted (`FILE_API_MODE=hosted`), a public server where each visitor gets a signed session:
//!   FILE_API_SESSION_SECRET   at least 32 characters; keeps sessions valid across restarts (required)
//!   FILE_API_ALLOWED_HOSTS    comma-separated public host names, e.g. orangefile.fly.dev (required)
//!   FILE_API_BIND             default 0.0.0.0:8080
//!   FILE_API_DATA_DIR         job storage
//!   FILE_API_STATIC_DIR       folder with the built web app to serve at /
//!   FILE_API_ALLOWED_ORIGINS  comma-separated origins of other sites allowed to call the API (usually none)
//!   FILE_API_CLIENT_IP_HEADER the header the platform's proxy puts the visitor's address in (fly-client-ip)
//!   FILE_API_MAX_FILE_MB      largest file, default 300
//!   FILE_API_TURNSTILE_SITE_KEY + FILE_API_TURNSTILE_SECRET   Cloudflare Turnstile keys: new visitors pass a CAPTCHA (optional)

use file_api::{start, ApiConfig};

fn main() -> std::io::Result<()> {
    // The PDF engine re-runs this executable as its sandboxed worker; do that before anything else.
    if std::env::args().nth(1).as_deref() == Some(file_core::pdf::worker::WORKER_FLAG) {
        std::process::exit(file_core::pdf::worker::main());
    }
    tokio::runtime::Builder::new_multi_thread().enable_all().build()?.block_on(serve())
}

fn list(var: &str) -> Vec<String> {
    std::env::var(var).unwrap_or_default().split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
}

fn invalid(msg: String) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidInput, msg)
}

async fn serve() -> std::io::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    let data_dir = std::env::var_os("FILE_API_DATA_DIR").map(Into::into).unwrap_or_else(|| std::env::temp_dir().join("file-api"));
    let hosted = std::env::var("FILE_API_MODE").is_ok_and(|m| m == "hosted");

    let mut cfg = if hosted {
        let secret = std::env::var("FILE_API_SESSION_SECRET").map_err(|_| invalid("FILE_API_SESSION_SECRET is required in hosted mode".into()))?;
        let mb: u64 = match std::env::var("FILE_API_MAX_FILE_MB") {
            Ok(v) => v.parse().map_err(|_| invalid("FILE_API_MAX_FILE_MB must be a whole number".into()))?,
            Err(_) => 300,
        };
        let mut c = ApiConfig::hosted(data_dir, &secret, list("FILE_API_ALLOWED_HOSTS"), mb * 1024 * 1024);
        c.allowed_origins = list("FILE_API_ALLOWED_ORIGINS");
        c.static_dir = std::env::var_os("FILE_API_STATIC_DIR").map(Into::into);
        c.client_ip_header = std::env::var("FILE_API_CLIENT_IP_HEADER").ok().filter(|s| !s.is_empty());
        let env = |k: &str| std::env::var(k).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        c.captcha = match (env("FILE_API_TURNSTILE_SITE_KEY"), env("FILE_API_TURNSTILE_SECRET")) {
            (Some(site_key), Some(secret)) => Some(file_api::Captcha { site_key, secret, verify_url: env("FILE_API_TURNSTILE_VERIFY_URL").unwrap_or_else(|| file_api::Captcha::CLOUDFLARE.into()) }),
            (None, None) => None,
            _ => return Err(invalid("Set both FILE_API_TURNSTILE_SITE_KEY and FILE_API_TURNSTILE_SECRET to turn the CAPTCHA on, or neither.".into())),
        };
        c
    } else {
        ApiConfig::local(data_dir)
    };
    if let Ok(b) = std::env::var("FILE_API_BIND") {
        cfg.bind = b.parse().map_err(|e| invalid(format!("FILE_API_BIND: {e}")))?;
    }
    let generated = !hosted && std::env::var("FILE_API_TOKEN").map(|t| cfg.token = t).is_err();

    let server = start(cfg).await?;
    println!("file-api listening on {}{}", server.base_url(), if hosted { " (hosted)" } else { "" });
    if generated {
        // Dev convenience only; the desktop app never prints its token.
        println!("token: {}", server.token);
    }
    wait_for_stop().await?;
    server.shutdown().await;
    Ok(())
}

/// Ctrl+C, or SIGTERM, which is how a container platform asks a program to stop.
async fn wait_for_stop() -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {
            r = tokio::signal::ctrl_c() => r,
            _ = term.recv() => Ok(()),
        }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await
}
