use crate::principal::{Principal, Tier};
use std::fmt;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

/// What one visitor may do. The desktop app's own engine is `Tier::Local` and is bound only by the engine's limits.
#[derive(Clone, Debug)]
pub struct TierLimits {
    pub max_file_bytes: u64,
    pub max_request_bytes: u64,
    pub max_files: usize,
    /// Jobs being uploaded or processed at once.
    pub max_active_jobs: usize,
    pub max_open_documents: usize,
    /// Bytes uploaded in a UTC day (jobs and opened PDFs together).
    pub daily_bytes: Option<u64>,
    pub jobs_per_hour: Option<u32>,
    /// The same, for everyone behind one network address, because a visitor can start any number of sessions.
    pub ip_active_jobs: Option<usize>,
    pub ip_jobs_per_hour: Option<u32>,
    pub ip_daily_bytes: Option<u64>,
}

const MIB: u64 = 1024 * 1024;

impl TierLimits {
    /// Limits for a public visitor with no account: a 300 MB file by default, a modest daily volume, one job at a time.
    pub fn anonymous(max_file_bytes: u64) -> Self {
        Self {
            max_file_bytes,
            max_request_bytes: max_file_bytes * 3,
            max_files: 20,
            max_active_jobs: 1,
            max_open_documents: 1,
            daily_bytes: Some(max_file_bytes * 6),
            jobs_per_hour: Some(30),
            ip_active_jobs: Some(4),
            ip_jobs_per_hour: Some(90),
            ip_daily_bytes: Some(max_file_bytes * 20),
        }
    }
}

#[derive(Clone)]
pub enum AuthMode {
    /// One shared bearer token, loopback only: the desktop app and development.
    LocalToken,
    /// Visitors get a signed session token from `POST /api/v1/session`.
    Sessions { secret: Vec<u8>, ttl: Duration },
}

#[derive(Clone)]
pub struct ApiConfig {
    /// Loopback unless `auth` is `Sessions`.
    pub bind: SocketAddr,
    /// Bearer token every `/api/v1` request must present (`AuthMode::LocalToken`).
    pub token: String,
    pub auth: AuthMode,
    /// Limits for visitors to a hosted server.
    pub anonymous: TierLimits,
    /// Host names the server answers to, besides the loopback ones (hosted: the public name).
    pub allowed_hosts: Vec<String>,
    /// Serve the built web app from this folder, at `/`.
    pub static_dir: Option<PathBuf>,
    /// The request header a trusted proxy puts the real client address in (`fly-client-ip`, or `x-forwarded-for`).
    pub client_ip_header: Option<String>,
    /// New sessions one address may start per hour.
    pub session_mints_per_ip_per_hour: u32,
    /// Private directory for per-job input/output files. The server owns its `job_*` entries.
    pub data_dir: PathBuf,
    pub max_file_bytes: u64,
    pub max_request_bytes: u64,
    pub max_files: usize,
    /// Uploading + stored jobs; new jobs are refused (429) beyond this.
    pub max_stored_jobs: usize,
    pub max_concurrent_processing: usize,
    /// How long a finished job's output stays downloadable.
    pub retention: Duration,
    pub sweep_interval: Duration,
    /// Upper bound on what an archive may expand to.
    pub max_extract_bytes: u64,
    /// PDFs held open at once; opening more closes the one used least recently.
    pub max_open_documents: usize,
    /// A PDF nobody has touched for this long is closed.
    pub document_idle: Duration,
    /// Browser origins allowed to call the API. Empty = no browser may.
    pub allowed_origins: Vec<String>,
    /// Hosted only: ask new visitors to pass a CAPTCHA (Cloudflare Turnstile) before they get a session.
    pub captcha: Option<Captcha>,
}

/// Cloudflare Turnstile. The site key is public (the browser needs it); the secret stays on the server.
#[derive(Clone)]
pub struct Captcha {
    pub site_key: String,
    pub secret: String,
    /// Where answers are checked; Cloudflare's address unless a test points it elsewhere.
    pub verify_url: String,
}

impl Captcha {
    pub const CLOUDFLARE: &'static str = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
}

const GIB: u64 = 1024 * 1024 * 1024;

impl ApiConfig {
    /// Defaults for the desktop-local mode: loopback, ephemeral port, fresh token.
    pub fn local(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            bind: SocketAddr::from(([127, 0, 0, 1], 0)),
            token: generate_token(),
            auth: AuthMode::LocalToken,
            anonymous: TierLimits::anonymous(300 * MIB),
            allowed_hosts: vec![],
            static_dir: None,
            client_ip_header: None,
            session_mints_per_ip_per_hour: 30,
            data_dir: data_dir.into(),
            max_file_bytes: 8 * GIB,
            max_request_bytes: 16 * GIB,
            max_files: 500,
            max_stored_jobs: 32,
            max_concurrent_processing: 2,
            retention: Duration::from_secs(15 * 60),
            sweep_interval: Duration::from_secs(10),
            max_extract_bytes: 20 * GIB,
            max_open_documents: 8,
            document_idle: Duration::from_secs(30 * 60),
            allowed_origins: vec![],
            captcha: None,
        }
    }

    /// Settings for a public server: any address, visitors identified by signed sessions, `max_file_bytes` per file.
    /// `allowed_hosts` are the names the server answers to (its public host name).
    pub fn hosted(data_dir: impl Into<PathBuf>, session_secret: &str, allowed_hosts: Vec<String>, max_file_bytes: u64) -> Self {
        let anonymous = TierLimits::anonymous(max_file_bytes);
        Self {
            bind: SocketAddr::from(([0, 0, 0, 0], 8080)),
            auth: AuthMode::Sessions { secret: session_secret.as_bytes().to_vec(), ttl: Duration::from_secs(24 * 3600) },
            allowed_hosts,
            // The engine-wide ceilings follow the visitor limits, because they also size the request body limit.
            max_file_bytes: anonymous.max_file_bytes,
            max_request_bytes: anonymous.max_request_bytes,
            max_files: anonymous.max_files,
            max_open_documents: 200,
            max_stored_jobs: 200,
            anonymous,
            ..Self::local(data_dir)
        }
    }

    /// The limits that apply to this visitor.
    pub fn limits_for(&self, who: &Principal) -> TierLimits {
        match who.tier {
            Tier::Local => TierLimits {
                max_file_bytes: self.max_file_bytes,
                max_request_bytes: self.max_request_bytes,
                max_files: self.max_files,
                max_active_jobs: usize::MAX,
                max_open_documents: self.max_open_documents,
                daily_bytes: None,
                jobs_per_hour: None,
                ip_active_jobs: None,
                ip_jobs_per_hour: None,
                ip_daily_bytes: None,
            },
            Tier::Anonymous => self.anonymous.clone(),
        }
    }

    pub(crate) fn validate(&self) -> std::io::Result<()> {
        use std::io::{Error, ErrorKind::InvalidInput};
        match &self.auth {
            AuthMode::LocalToken => {
                if !self.bind.ip().is_loopback() {
                    return Err(Error::new(InvalidInput, "without sessions, file-api only binds to loopback addresses"));
                }
                if self.token.len() < 32 {
                    return Err(Error::new(InvalidInput, "API token must be at least 32 characters"));
                }
            }
                    AuthMode::Sessions { secret, .. } => {
                if secret.len() < 32 {
                    return Err(Error::new(InvalidInput, "the session secret must be at least 32 characters"));
                }
                if self.allowed_hosts.is_empty() {
                    return Err(Error::new(InvalidInput, "a hosted server needs the host name(s) it answers to (FILE_API_ALLOWED_HOSTS)"));
                }
            }
        }
        Ok(())
    }
}

impl ApiConfig {
    /// A public server, where visitors share the machine.
    pub fn is_hosted(&self) -> bool {
        matches!(self.auth, AuthMode::Sessions { .. })
    }
}

impl fmt::Debug for ApiConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ApiConfig")
            .field("bind", &self.bind)
            .field("token", &"***")
            .field("data_dir", &self.data_dir)
            .finish_non_exhaustive()
    }
}

/// 244 bits of OS randomness, hex-encoded.
pub fn generate_token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}
