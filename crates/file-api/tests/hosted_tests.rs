//! A hosted server: visitors with signed sessions, their limits, and what they must not be able to do to each other.
//! No outside service is needed; everything runs against a real server on loopback.

use file_api::types::*;
use file_api::{start, start_with, ApiConfig, RunningServer};
use reqwest::{multipart, Client, StatusCode};
use serde_json::{json, Value};
use std::path::Path;
use std::time::{Duration, Instant};

const SECRET: &str = "a-test-secret-that-is-comfortably-longer-than-32-chars";

fn png(w: u32, h: u32) -> Vec<u8> {
    let img = image::RgbImage::from_pixel(w, h, image::Rgb([200, 30, 30]));
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

struct Hosted {
    server: RunningServer,
    http: Client,
    _root: tempfile::TempDir,
}

impl Hosted {
    async fn new() -> Self {
        Self::with(|_| {}).await
    }

    async fn with(tweak: impl FnOnce(&mut ApiConfig)) -> Self {
        let root = tempfile::tempdir().unwrap();
        let mut cfg = ApiConfig::hosted(root.path().join("jobs"), SECRET, vec!["orangefile.test".into()], 100 * 1024 * 1024);
        cfg.bind = "127.0.0.1:0".parse().unwrap();
        cfg.sweep_interval = Duration::from_millis(100);
        tweak(&mut cfg);
        let server = start(cfg).await.unwrap();
        Hosted { server, http: Client::new(), _root: root }
    }

    fn url(&self, p: &str) -> String {
        format!("{}{p}", self.server.base_url())
    }

    /// A new visitor. `ip` is what the platform's proxy would say about them (only used when a header is configured).
    async fn visitor(&self, ip: &str) -> Visitor<'_> {
        let r = self.http.post(self.url("/api/v1/session")).header("fly-client-ip", ip).send().await.unwrap();
        assert_eq!(r.status(), 200, "{:?}", r.text().await);
        let s: SessionResponse = r.json().await.unwrap();
        Visitor { h: self, token: s.token, ip: ip.to_string() }
    }
}

struct Visitor<'a> {
    h: &'a Hosted,
    token: String,
    ip: String,
}

impl Visitor<'_> {
    fn req(&self, m: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        self.h.http.request(m, self.h.url(path)).header("authorization", format!("Bearer {}", self.token)).header("fly-client-ip", &self.ip)
    }
    async fn get(&self, path: &str) -> reqwest::Response {
        self.req(reqwest::Method::GET, path).send().await.unwrap()
    }
    async fn post_job(&self, files: Vec<(&str, Vec<u8>)>) -> reqwest::Response {
        let mut form = multipart::Form::new().text("operation", "convert").text("options", r#"{"format":"jpeg"}"#);
        for (n, b) in files {
            form = form.part("files", multipart::Part::bytes(b).file_name(n.to_string()));
        }
        self.req(reqwest::Method::POST, "/api/v1/jobs").multipart(form).send().await.unwrap()
    }
    async fn run_job(&self) -> String {
        let r = self.post_job(vec![("a.png", png(8, 8))]).await;
        assert_eq!(r.status(), StatusCode::ACCEPTED, "{:?}", r.text().await);
        let id = r.json::<CreateJobResponse>().await.unwrap().job_id;
        let t = Instant::now();
        loop {
            let s: JobResponse = self.get(&format!("/api/v1/jobs/{id}")).await.json().await.unwrap();
            if s.status.is_finished() {
                assert_eq!(s.status, WireStatus::Completed, "{s:?}");
                return id;
            }
            assert!(t.elapsed() < Duration::from_secs(30));
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

async fn code(r: reqwest::Response) -> (StatusCode, String) {
    let status = r.status();
    let v: Value = r.json().await.unwrap_or(Value::Null);
    (status, v["error"]["code"].as_str().unwrap_or("").to_string())
}

// ------------------------------------------------------------------ identity

#[tokio::test]
async fn a_session_is_needed_and_checked() {
    let h = Hosted::new().await;
    // nothing, junk, and a forged token are all refused
    assert_eq!(h.http.get(h.url("/api/v1/capabilities")).send().await.unwrap().status(), 401);
    for bad in ["Bearer nope", "Bearer of1.00000000000000000000000000000000.9999999999.deadbeef", "Basic abc"] {
        assert_eq!(h.http.get(h.url("/api/v1/capabilities")).header("authorization", bad).send().await.unwrap().status(), 401, "{bad}");
    }
    let v = h.visitor("1.1.1.1").await;
    assert_eq!(v.get("/api/v1/capabilities").await.status(), 200);

    // a token signed under another server's secret is worthless here
    let other = Hosted::with(|c| c.auth = file_api::AuthMode::Sessions { secret: b"another-secret-also-longer-than-32-characters!".to_vec(), ttl: Duration::from_secs(3600) }).await;
    let theirs = other.visitor("1.1.1.1").await;
    assert_eq!(h.http.get(h.url("/api/v1/capabilities")).header("authorization", format!("Bearer {}", theirs.token)).send().await.unwrap().status(), 401);

    // the shared local token mode has no /session at all
    let local_root = tempfile::tempdir().unwrap();
    let local = start(ApiConfig::local(local_root.path().join("j"))).await.unwrap();
    let r = Client::new().post(format!("{}/api/v1/session", local.base_url())).header("authorization", format!("Bearer {}", local.token)).send().await.unwrap();
    assert_eq!(code(r).await, (StatusCode::NOT_FOUND, "NOT_FOUND".into()), "a local engine says 404, which is how the web app knows it is local");
}

#[tokio::test]
async fn refreshing_keeps_the_visitor_and_new_sessions_are_rate_limited() {
    let h = Hosted::with(|c| {
        c.session_mints_per_ip_per_hour = 2;
        c.client_ip_header = Some("fly-client-ip".into());
    })
    .await;
    let a = h.visitor("5.5.5.5").await;
    let id = a.run_job().await;
    // refresh with the old token: same visitor, so the job is still theirs
    let r = h.http.post(h.url("/api/v1/session")).header("authorization", format!("Bearer {}", a.token)).header("fly-client-ip", "5.5.5.5").send().await.unwrap();
    let again: SessionResponse = r.json().await.unwrap();
    let a2 = Visitor { h: &h, token: again.token, ip: "5.5.5.5".into() };
    assert_eq!(a2.get(&format!("/api/v1/jobs/{id}")).await.status(), 200);
    // refreshing doesn't use up the allowance; new visitors do (one used above, a second now, the third is refused)
    h.visitor("5.5.5.5").await;
    let r = h.http.post(h.url("/api/v1/session")).header("fly-client-ip", "5.5.5.5").send().await.unwrap();
    assert_eq!(code(r).await, (StatusCode::TOO_MANY_REQUESTS, "RATE_LIMITED".into()));
    // another address is fine
    h.visitor("6.6.6.6").await;
}

#[tokio::test]
async fn me_reports_the_visitors_limits_and_usage() {
    let h = Hosted::new().await;
    let v = h.visitor("1.1.1.1").await;
    let me: MeResponse = v.get("/api/v1/me").await.json().await.unwrap();
    assert_eq!(me.tier, "anonymous");
    assert_eq!(me.limits.max_file_bytes, 100 * 1024 * 1024, "the 100 MB limit");
    assert_eq!(me.usage.bytes_today, 0);
    v.run_job().await;
    let me: MeResponse = v.get("/api/v1/me").await.json().await.unwrap();
    assert!(me.usage.bytes_today > 0 && me.usage.jobs_this_hour == 1, "{me:?}");
    let caps: file_core::Capabilities = v.get("/api/v1/capabilities").await.json().await.unwrap();
    assert_eq!(caps.limits.max_file_bytes, Some(100 * 1024 * 1024), "the capability report tells the visitor their own limit");
}

// ------------------------------------------------------------------ nobody sees anybody else's work

#[tokio::test]
async fn one_visitor_cannot_touch_anothers_jobs() {
    let h = Hosted::new().await;
    let (a, b) = (h.visitor("1.1.1.1").await, h.visitor("2.2.2.2").await);
    let id = a.run_job().await;
    for path in [format!("/api/v1/jobs/{id}"), format!("/api/v1/jobs/{id}/result"), format!("/api/v1/jobs/{id}/result/files"), format!("/api/v1/jobs/{id}/result/files/0")] {
        assert_eq!(code(b.get(&path).await).await, (StatusCode::NOT_FOUND, "JOB_NOT_FOUND".into()), "{path}");
        assert_eq!(a.get(&path).await.status(), 200, "{path} for the owner");
    }
    assert_eq!(b.req(reqwest::Method::POST, &format!("/api/v1/jobs/{id}/cancel")).send().await.unwrap().status(), 404);
    assert_eq!(b.req(reqwest::Method::DELETE, &format!("/api/v1/jobs/{id}")).send().await.unwrap().status(), 404);
    let r = b.req(reqwest::Method::POST, &format!("/api/v1/jobs/{id}/link")).send().await.unwrap();
    assert_eq!(r.status(), 404, "and can't get a download link to it");
    // a job id that was never issued looks exactly the same
    assert_eq!(code(b.get("/api/v1/jobs/job_00000000000000000000000000000000").await).await, (StatusCode::NOT_FOUND, "JOB_NOT_FOUND".into()));
}

#[tokio::test]
async fn one_visitor_cannot_touch_anothers_open_pdfs() {
    let Some(dir) = std::env::var_os("ORANGEFILE_PDFIUM") else {
        assert!(std::env::var_os("ORANGEFILE_REQUIRE_PDFIUM").is_none());
        eprintln!("skipped: ORANGEFILE_PDFIUM is not set");
        return;
    };
    use file_core::engine::pdf::{HostConfig, PdfHost, WorkerProgram};
    let mut cfg = HostConfig::for_app().with_worker(WorkerProgram::Exe(std::path::PathBuf::from(env!("CARGO_BIN_EXE_file-api"))));
    cfg.library_dirs = vec![Path::new(&dir).to_path_buf()];
    let registry = std::sync::Arc::new(file_core::Registry::bundled_with(std::sync::Arc::new(PdfHost::new(cfg))));
    let root = tempfile::tempdir().unwrap();
    let mut c = ApiConfig::hosted(root.path().join("jobs"), SECRET, vec!["orangefile.test".into()], 100 * 1024 * 1024);
    c.bind = "127.0.0.1:0".parse().unwrap();
    let server = start_with(c, registry).await.unwrap();
    let h = Hosted { server, http: Client::new(), _root: root };
    let (a, b) = (h.visitor("1.1.1.1").await, h.visitor("2.2.2.2").await);
    let pdf = std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../file-core/tests/fixtures/pdf/three-pages.pdf")).unwrap();
    let form = multipart::Form::new().part("file", multipart::Part::bytes(pdf.clone()).file_name("t.pdf"));
    let r = a.req(reqwest::Method::POST, "/api/v1/pdf/documents").multipart(form).send().await.unwrap();
    assert_eq!(r.status(), 201, "{:?}", r.text().await);
    let doc: PdfDocumentResponse = r.json().await.unwrap();
    let page = format!("/api/v1/pdf/documents/{}/pages/1/image?width=200", doc.id);
    assert_eq!(a.get(&page).await.status(), 200);
    assert_eq!(code(b.get(&page).await).await, (StatusCode::NOT_FOUND, "DOCUMENT_NOT_FOUND".into()));
    assert_eq!(b.get(&format!("/api/v1/pdf/documents/{}", doc.id)).await.status(), 404);
    assert_eq!(b.req(reqwest::Method::DELETE, &format!("/api/v1/pdf/documents/{}", doc.id)).send().await.unwrap().status(), 404);
    assert_eq!(a.get(&page).await.status(), 200, "B's attempts didn't close A's document");
    // opening a second one closes this visitor's first (one at a time), and never B's
    let b_doc: PdfDocumentResponse = b.req(reqwest::Method::POST, "/api/v1/pdf/documents").multipart(multipart::Form::new().part("file", multipart::Part::bytes(pdf.clone()).file_name("b.pdf"))).send().await.unwrap().json().await.unwrap();
    let again = multipart::Form::new().part("file", multipart::Part::bytes(pdf).file_name("t2.pdf"));
    assert_eq!(a.req(reqwest::Method::POST, "/api/v1/pdf/documents").multipart(again).send().await.unwrap().status(), 201);
    assert_eq!(a.get(&page).await.status(), 404, "A's first was closed to make room for A's second");
    assert_eq!(b.get(&format!("/api/v1/pdf/documents/{}/pages/1/image?width=200", b_doc.id)).await.status(), 200, "B's is untouched");
}

// ------------------------------------------------------------------ limits

#[tokio::test]
async fn the_file_size_limit_is_enforced_while_uploading() {
    let h = Hosted::with(|c| {
        c.max_file_bytes = 3000;
        c.max_request_bytes = 5000;
        c.anonymous.max_file_bytes = 3000;
        c.anonymous.max_request_bytes = 5000;
        c.anonymous.max_files = 2;
    })
    .await;
    let v = h.visitor("1.1.1.1").await;
    let big = vec![0x89u8; 4000];
    let r = v.post_job(vec![("big.png", big)]).await;
    let (status, c) = code(r).await;
    assert_eq!((status, c.as_str()), (StatusCode::PAYLOAD_TOO_LARGE, "PAYLOAD_TOO_LARGE"));
    // together too much, though each file is fine
    let tiny = png(40, 40); // about 150 bytes: keep it under the per-file limit
    let r = v.post_job(vec![("a.png", [tiny.clone(), vec![0; 2500]].concat()), ("b.png", [tiny.clone(), vec![0; 2500]].concat())]).await;
    assert_eq!(r.status(), 413);
    // too many files
    let r = v.post_job(vec![("a.png", tiny.clone()), ("b.png", tiny.clone()), ("c.png", tiny)]).await;
    assert_eq!(r.status(), 413);
    // the pre-check says the same without uploading anything, with the limit named
    let p: PreviewResponse = v
        .req(reqwest::Method::POST, "/api/v1/jobs/preview")
        .json(&json!({"operation": "convert", "options": {"format": "jpeg"}, "files": [{"name": "x.png", "size": 4000, "head_hex": "89504e470d0a1a0a"}]}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(p.errors.iter().any(|e| e.code == "PAYLOAD_TOO_LARGE" && e.message.contains("limit")), "{p:?}");
    // a refused upload leaves nothing on disk
    assert!(std::fs::read_dir(h._root.path().join("jobs")).unwrap().next().is_none());
}

#[tokio::test]
async fn one_job_at_a_time_and_a_stalled_upload_holds_the_place() {
    let h = Hosted::new().await;
    let v = h.visitor("1.1.1.1").await;
    // an upload that has started but not finished
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(4);
    let boundary = "XBOUNDARY";
    let head = format!("--{boundary}\r\nContent-Disposition: form-data; name=\"operation\"\r\n\r\nconvert\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"options\"\r\n\r\n{{\"format\":\"jpeg\"}}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"a.png\"\r\nContent-Type: image/png\r\n\r\n");
    tx.send(Ok(head.into_bytes())).await.unwrap();
    tx.send(Ok(png(8, 8)[..20].to_vec())).await.unwrap();
    let body = reqwest::Body::wrap_stream(tokio_stream::wrappers::ReceiverStream::new(rx));
    let slow = v.req(reqwest::Method::POST, "/api/v1/jobs").header("content-type", format!("multipart/form-data; boundary={boundary}")).body(body).send();
    let slow = tokio::spawn(slow);
    tokio::time::sleep(Duration::from_millis(400)).await;
    let r = v.post_job(vec![("b.png", png(8, 8))]).await;
    assert_eq!(code(r).await, (StatusCode::TOO_MANY_REQUESTS, "TOO_MANY_JOBS".into()), "a second job while one is being uploaded");
    // another visitor is unaffected
    let other = h.visitor("9.9.9.9").await;
    other.run_job().await;
    drop(tx); // abandon the stalled upload
    let _ = slow.await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    v.run_job().await; // the place is free again
}

#[tokio::test]
async fn the_daily_volume_is_limited_and_counted() {
    let h = Hosted::with(|c| {
        c.anonymous.daily_bytes = Some(2500);
        c.anonymous.ip_daily_bytes = None;
    })
    .await;
    let v = h.visitor("1.1.1.1").await;
    let img = png(30, 30);
    let each = img.len() as u64;
    assert!(each > 50 && each < 1500, "test image is {each} bytes");
    v.run_job().await; // a small one first
    let mut sent = 0;
    let mut refused = None;
    for _ in 0..40 {
        let r = v.post_job(vec![("a.png", img.clone())]).await;
        if r.status() == StatusCode::ACCEPTED {
            sent += each;
            // wait for it, so "one at a time" doesn't get in the way
            let id = r.json::<CreateJobResponse>().await.unwrap().job_id;
            for _ in 0..200 {
                let s: JobResponse = v.get(&format!("/api/v1/jobs/{id}")).await.json().await.unwrap();
                if s.status.is_finished() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        } else {
            refused = Some(code(r).await);
            break;
        }
    }
    assert_eq!(refused, Some((StatusCode::TOO_MANY_REQUESTS, "DAILY_LIMIT".into())), "refused after about 2500 bytes (sent {sent} more)");
    let me: MeResponse = v.get("/api/v1/me").await.json().await.unwrap();
    assert!(me.usage.bytes_today >= 2500, "{me:?}");
    // somebody else has their own allowance
    h.visitor("2.2.2.2").await.run_job().await;
}

#[tokio::test]
async fn making_new_sessions_does_not_escape_the_address_limit() {
    let h = Hosted::with(|c| {
        c.anonymous.max_active_jobs = 10;
        c.anonymous.jobs_per_hour = None;
        c.anonymous.ip_jobs_per_hour = Some(3);
        c.client_ip_header = Some("fly-client-ip".into());
    })
    .await;
    // five different visitors behind one address: only three jobs an hour between them
    let mut accepted = 0;
    for i in 0..5 {
        let v = h.visitor("7.7.7.7").await;
        let r = v.post_job(vec![("a.png", png(8, 8))]).await;
        if r.status() == StatusCode::ACCEPTED {
            accepted += 1;
        } else {
            assert_eq!(code(r).await, (StatusCode::TOO_MANY_REQUESTS, "RATE_LIMITED".into()), "visitor {i}");
        }
    }
    assert_eq!(accepted, 3);
    // and a different address starts fresh
    h.visitor("8.8.8.8").await.run_job().await;
}

// ------------------------------------------------------------------ signed download links

#[tokio::test]
async fn a_signed_link_downloads_without_a_header_and_cannot_be_forged() {
    let h = Hosted::new().await;
    let (a, b) = (h.visitor("1.1.1.1").await, h.visitor("2.2.2.2").await);
    let id = a.run_job().await;

    // without a link, no header means no download
    assert_eq!(h.http.get(h.url(&format!("/api/v1/jobs/{id}/result"))).send().await.unwrap().status(), 401);

    let link: LinkResponse = a.req(reqwest::Method::POST, &format!("/api/v1/jobs/{id}/link")).send().await.unwrap().json().await.unwrap();
    assert!(link.url.starts_with(&format!("/api/v1/dl/{id}/all?exp=")), "{}", link.url);
    assert_eq!(link.expires_in, 120);
    let r = h.http.get(h.url(&link.url)).send().await.unwrap(); // no Authorization header at all
    assert_eq!(r.status(), 200);
    assert!(r.headers()["content-disposition"].to_str().unwrap().starts_with("attachment"), "downloads, never displays");
    assert_eq!(r.headers()["x-content-type-options"], "nosniff");
    assert_eq!(&r.bytes().await.unwrap()[..3], [0xff, 0xd8, 0xff], "a JPEG");

    // one result file by index
    let one: LinkResponse = a.req(reqwest::Method::POST, &format!("/api/v1/jobs/{id}/link")).json(&json!({"index": 0})).send().await.unwrap().json().await.unwrap();
    assert!(one.url.contains("/dl/") && one.url.contains("/0?exp="));
    assert_eq!(h.http.get(h.url(&one.url)).send().await.unwrap().status(), 200);

    // forgeries
    let (path, query) = link.url.split_once('?').unwrap();
    let sig = query.split("sig=").nth(1).unwrap();
    let tampered = format!("{path}?{}", query.replace(sig, &"0".repeat(sig.len())));
    assert_eq!(code(h.http.get(h.url(&tampered)).send().await.unwrap()).await, (StatusCode::FORBIDDEN, "LINK_INVALID".into()));
    let other_file = link.url.replace("/all?", "/1?");
    assert_eq!(h.http.get(h.url(&other_file)).send().await.unwrap().status(), 403, "a link for 'all' isn't one for file 1");
    let longer = link.url.replacen("exp=", "exp=9", 1);
    assert_eq!(h.http.get(h.url(&longer)).send().await.unwrap().status(), 403, "an extended expiry");
    let other_job = link.url.replace(&id, "job_00000000000000000000000000000000");
    assert_eq!(h.http.get(h.url(&other_job)).send().await.unwrap().status(), 403);
    assert_eq!(h.http.get(h.url(&format!("/api/v1/dl/{id}/all"))).send().await.unwrap().status(), 400, "no signature at all");
    // B can't ask for a link to A's job
    assert_eq!(b.req(reqwest::Method::POST, &format!("/api/v1/jobs/{id}/link")).send().await.unwrap().status(), 404);
}

// ------------------------------------------------------------------ the browser's view: hosts, origins, the web app

#[tokio::test]
async fn hosts_and_origins_are_checked() {
    let h = Hosted::with(|c| c.allowed_origins = vec!["https://app.example".into()]).await;
    let v = h.visitor("1.1.1.1").await;
    let get = |host: Option<&str>, origin: Option<&str>| {
        let mut r = h.http.get(h.url("/api/v1/capabilities")).header("authorization", format!("Bearer {}", v.token));
        if let Some(x) = host {
            r = r.header("host", x);
        }
        if let Some(o) = origin {
            r = r.header("origin", o);
        }
        r
    };
    assert_eq!(get(None, None).send().await.unwrap().status(), 200, "loopback name");
    assert_eq!(get(Some("orangefile.test"), None).send().await.unwrap().status(), 200, "the configured public name");
    assert_eq!(code(get(Some("evil.example"), None).send().await.unwrap()).await, (StatusCode::FORBIDDEN, "FORBIDDEN_HOST".into()));
    assert_eq!(h.http.get(h.url("/health")).header("host", "10.1.2.3:8080").send().await.unwrap().status(), 200, "health checks from a platform may use any Host");

    // origins: our own page (the origin is this very host), the listed site, and nobody else
    assert_eq!(get(Some("orangefile.test"), Some("https://orangefile.test")).send().await.unwrap().status(), 200);
    let r = get(Some("orangefile.test"), Some("https://app.example")).send().await.unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.headers()["access-control-allow-origin"], "https://app.example");
    assert_eq!(code(get(Some("orangefile.test"), Some("https://evil.example")).send().await.unwrap()).await, (StatusCode::FORBIDDEN, "FORBIDDEN_ORIGIN".into()));

    // the browser's preflight is answered for a listed origin, with no token, and only for those
    let pre = |origin: &str| h.http.request(reqwest::Method::OPTIONS, h.url("/api/v1/jobs")).header("origin", origin).header("access-control-request-method", "POST").header("access-control-request-headers", "authorization");
    let ok = pre("https://app.example").send().await.unwrap();
    assert!(ok.status().is_success(), "{}", ok.status());
    assert_eq!(ok.headers()["access-control-allow-origin"], "https://app.example");
    assert!(ok.headers()["access-control-allow-headers"].to_str().unwrap().contains("authorization"));
    // the CAPTCHA answer travels in its own header, which a separate site (Netlify) must be allowed to send
    let cap = h.http.request(reqwest::Method::OPTIONS, h.url("/api/v1/session")).header("origin", "https://app.example").header("access-control-request-method", "POST").header("access-control-request-headers", "x-turnstile-token").send().await.unwrap();
    assert!(cap.status().is_success(), "{}", cap.status());
    assert!(cap.headers()["access-control-allow-headers"].to_str().unwrap().contains("x-turnstile-token"), "the CAPTCHA header is allowed across origins");
    let no = pre("https://evil.example").send().await.unwrap();
    assert!(no.headers().get("access-control-allow-origin").is_none(), "nothing is granted to an unlisted origin");
}

#[tokio::test]
async fn the_web_app_is_served_with_a_strict_policy_and_the_api_is_not_shadowed() {
    let site = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(site.path().join("assets")).unwrap();
    std::fs::write(site.path().join("index.html"), "<!doctype html><title>OrangeFile</title><div id=root></div>").unwrap();
    std::fs::write(site.path().join("assets/app.js"), "console.log('hi')").unwrap();
    let secret = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(secret.path(), "TOP SECRET").unwrap();
    let dir = site.path().to_path_buf();
    let h = Hosted::with(move |c| c.static_dir = Some(dir)).await;

    let page = h.http.get(h.url("/")).send().await.unwrap();
    assert_eq!(page.status(), 200);
    let csp = page.headers()["content-security-policy"].to_str().unwrap().to_string();
    for must in ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "script-src 'self'"] {
        assert!(csp.contains(must), "{must} in {csp}");
    }
    assert_eq!(page.headers()["x-content-type-options"], "nosniff");
    assert!(page.text().await.unwrap().contains("OrangeFile"));
    assert_eq!(h.http.get(h.url("/assets/app.js")).send().await.unwrap().status(), 200);
    // the app has its own routes, so an unknown path gets the app
    let deep = h.http.get(h.url("/pdf/editor")).send().await.unwrap();
    assert_eq!(deep.status(), 200);
    assert!(deep.text().await.unwrap().contains("OrangeFile"));
    // ...but never for the API: that stays JSON, and still needs a session
    assert_eq!(h.http.get(h.url("/api/v1/no-such-thing")).send().await.unwrap().status(), 401);
    let v = h.visitor("1.1.1.1").await;
    let r = v.get("/api/v1/no-such-thing").await;
    assert_eq!(code(r).await, (StatusCode::NOT_FOUND, "NOT_FOUND".into()));
    let api = v.get("/api/v1/capabilities").await;
    assert!(api.headers().get("content-security-policy").is_none(), "the policy is for pages, not the API");
    assert_eq!(api.headers()["cache-control"], "no-store");
    // walking out of the folder doesn't work
    let name = secret.path().file_name().unwrap().to_string_lossy().to_string();
    for p in [format!("/../{name}"), format!("/%2e%2e/{name}"), format!("/assets/..%2f..%2f{name}")] {
        let r = h.http.get(h.url(&p)).send().await.unwrap();
        assert!(!r.text().await.unwrap().contains("TOP SECRET"), "{p}");
    }
}

// ------------------------------------------------------------------ configuration mistakes are refused at start

#[tokio::test]
async fn unsafe_configurations_do_not_start() {
    let root = tempfile::tempdir().unwrap();
    let dir = || root.path().join("j");
    // a public address with only the shared token
    let mut c = ApiConfig::local(dir());
    c.bind = "0.0.0.0:0".parse().unwrap();
    assert!(start(c).await.is_err(), "a shared token must stay on loopback");
    // a short session secret
    let mut c = ApiConfig::hosted(dir(), "too short", vec!["x.test".into()], 1 << 20);
    c.bind = "127.0.0.1:0".parse().unwrap();
    assert!(start(c).await.is_err());
    // no host name to answer to
    let mut c = ApiConfig::hosted(dir(), SECRET, vec![], 1 << 20);
    c.bind = "127.0.0.1:0".parse().unwrap();
    assert!(start(c).await.is_err());
    // the sane one starts, on any address
    let mut c = ApiConfig::hosted(dir(), SECRET, vec!["x.test".into()], 1 << 20);
    c.bind = "0.0.0.0:0".parse().unwrap();
    start(c).await.unwrap().shutdown().await;
}

// ------------------------------------------------------------------ CAPTCHA

/// A stand-in for Cloudflare's checker: "good" passes, anything else fails. Records what it was asked.
async fn fake_turnstile() -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
    use axum::{routing::post, Form, Router};
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let log = seen.clone();
    let app = Router::new().route(
        "/siteverify",
        post(move |Form(f): Form<std::collections::HashMap<String, String>>| {
            let log = log.clone();
            async move {
                assert_eq!(f.get("secret").map(String::as_str), Some("server-secret"), "the secret is sent");
                let answer = f.get("response").cloned().unwrap_or_default();
                log.lock().unwrap().push(answer.clone());
                axum::Json(json!({ "success": answer == "good" }))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}/siteverify"), seen)
}

#[tokio::test]
async fn new_sessions_need_a_passed_captcha_when_configured() {
    let (url, seen) = fake_turnstile().await;
    let h = Hosted::with(|c| {
        c.captcha = Some(file_api::Captcha { site_key: "public-site-key".into(), secret: "server-secret".into(), verify_url: url });
    })
    .await;
    let session = |answer: Option<&str>| {
        let mut r = h.http.post(h.url("/api/v1/session"));
        if let Some(a) = answer {
            r = r.header("x-turnstile-token", a);
        }
        r
    };

    // no answer: told what to show, with the public key only
    let r = session(None).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
    let body: Value = r.json().await.unwrap();
    assert_eq!(body["error"]["code"], "CAPTCHA_REQUIRED");
    assert_eq!(body["captcha"]["provider"], "turnstile");
    assert_eq!(body["captcha"]["site_key"], "public-site-key");
    assert!(!body.to_string().contains("server-secret"), "the secret never leaves the server");

    // a wrong answer is checked and refused
    let r = session(Some("bad")).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
    assert_eq!(r.json::<Value>().await.unwrap()["error"]["code"], "CAPTCHA_FAILED");

    // a right one gives a session
    let r = session(Some("good")).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let s: SessionResponse = r.json().await.unwrap();
    assert_eq!(seen.lock().unwrap().as_slice(), ["bad", "good"]);

    // extending a valid session needs no new challenge
    let r = h.http.post(h.url("/api/v1/session")).header("authorization", format!("Bearer {}", s.token)).send().await.unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(seen.lock().unwrap().len(), 2, "Cloudflare wasn't asked again");

    // the session works for the API
    let r = h.http.get(h.url("/api/v1/me")).header("authorization", format!("Bearer {}", s.token)).send().await.unwrap();
    assert_eq!(r.status(), 200);
}

#[tokio::test]
async fn an_unreachable_captcha_checker_refuses_new_sessions() {
    let h = Hosted::with(|c| {
        c.captcha = Some(file_api::Captcha { site_key: "k".into(), secret: "s".into(), verify_url: "http://127.0.0.1:9/siteverify".into() });
    })
    .await;
    let r = h.http.post(h.url("/api/v1/session")).header("x-turnstile-token", "anything").send().await.unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN, "fails closed");
}
