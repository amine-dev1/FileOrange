//! Signed tokens: the session a visitor carries, and the short-lived link that lets a browser download a result.
//! Both are `payload.signature`, signed with HMAC-SHA256 under keys derived from one server secret. Nothing is stored:
//! a token is valid because the signature checks out and the time hasn't passed.

use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

type HmacSha256 = Hmac<Sha256>;

pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[derive(Clone)]
pub struct Access {
    session_key: Vec<u8>,
    link_key: Vec<u8>,
    pub session_ttl: Duration,
    pub link_ttl: Duration,
}

fn derive(secret: &[u8], purpose: &str) -> Vec<u8> {
    let mut m = HmacSha256::new_from_slice(secret).expect("any length is fine");
    m.update(purpose.as_bytes());
    m.finalize().into_bytes().to_vec()
}

fn sign(key: &[u8], text: &str) -> String {
    let mut m = HmacSha256::new_from_slice(key).expect("any length is fine");
    m.update(text.as_bytes());
    hex::encode(m.finalize().into_bytes())
}

fn verify(key: &[u8], text: &str, sig_hex: &str) -> bool {
    let Ok(sig) = hex::decode(sig_hex) else { return false };
    let mut m = HmacSha256::new_from_slice(key).expect("any length is fine");
    m.update(text.as_bytes());
    m.verify_slice(&sig).is_ok() // constant time
}

impl Access {
    pub fn new(secret: &[u8], session_ttl: Duration) -> Self {
        Self { session_key: derive(secret, "orangefile session v1"), link_key: derive(secret, "orangefile link v1"), session_ttl, link_ttl: Duration::from_secs(120) }
    }

    pub fn random() -> Self {
        Self::new(crate::config::generate_token().as_bytes(), Duration::from_secs(24 * 3600))
    }

    /// A fresh visitor id (32 hex digits of OS randomness).
    pub fn new_visitor_id() -> String {
        uuid::Uuid::new_v4().simple().to_string()
    }

    /// A session token for `id`: `of1.<id>.<expires>.<signature>`. Returns the token and its lifetime in seconds.
    pub fn session_token(&self, id: &str) -> (String, u64) {
        let exp = now() + self.session_ttl.as_secs();
        let body = format!("of1.{id}.{exp}");
        (format!("{body}.{}", sign(&self.session_key, &body)), self.session_ttl.as_secs())
    }

    /// The visitor id inside a valid, unexpired session token.
    pub fn session_id(&self, token: &str) -> Option<String> {
        let (body, sig) = token.rsplit_once('.')?;
        let mut parts = body.split('.');
        let (tag, id, exp) = (parts.next()?, parts.next()?, parts.next()?);
        if tag != "of1" || parts.next().is_some() || id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let exp: u64 = exp.parse().ok()?;
        (exp > now() && verify(&self.session_key, body, sig)).then(|| id.to_string())
    }

    /// Expiry (unix seconds) and signature for a download link to `which` (`all`, or a file index) of job `job`.
    pub fn link(&self, job: &str, which: &str) -> (u64, String) {
        let exp = now() + self.link_ttl.as_secs();
        (exp, sign(&self.link_key, &format!("dl|{job}|{which}|{exp}")))
    }

    pub fn verify_link(&self, job: &str, which: &str, exp: u64, sig: &str) -> bool {
        exp > now() && verify(&self.link_key, &format!("dl|{job}|{which}|{exp}"), sig)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn access() -> Access {
        Access::new(b"a secret that is long enough for the tests", Duration::from_secs(3600))
    }

    #[test]
    fn session_tokens_round_trip_and_reject_tampering() {
        let a = access();
        let id = Access::new_visitor_id();
        let (t, ttl) = a.session_token(&id);
        assert_eq!(ttl, 3600);
        assert_eq!(a.session_id(&t).as_deref(), Some(id.as_str()));
        let other = Access::new(b"a different secret, equally long as above....", Duration::from_secs(3600));
        assert_eq!(other.session_id(&t), None, "another server's secret doesn't accept it");
        let forged = t.replacen(&id, &Access::new_visitor_id(), 1);
        assert_eq!(a.session_id(&forged), None, "changing the id breaks the signature");
        let (body, sig) = t.rsplit_once('.').unwrap();
        let longer = body.rsplit_once('.').map(|(h, _)| format!("{h}.{}", now() + 999_999)).unwrap();
        assert_eq!(a.session_id(&format!("{longer}.{sig}")), None, "extending the expiry breaks it too");
        for junk in ["", "x", "of1..", "of1.abc.1.2", "of2.a.b.c", &format!("{t}.extra"), &t.to_uppercase()] {
            assert_eq!(a.session_id(junk), None, "{junk:?}");
        }
    }

    #[test]
    fn expired_sessions_are_refused() {
        let a = Access::new(b"a secret that is long enough for the tests", Duration::from_secs(0));
        let (t, _) = a.session_token(&Access::new_visitor_id());
        assert_eq!(a.session_id(&t), None);
    }

    #[test]
    fn a_link_is_good_only_for_its_own_job_file_and_time() {
        let a = access();
        let (exp, sig) = a.link("job_1", "all");
        assert!(a.verify_link("job_1", "all", exp, &sig));
        assert!(!a.verify_link("job_2", "all", exp, &sig), "another job");
        assert!(!a.verify_link("job_1", "0", exp, &sig), "another file");
        assert!(!a.verify_link("job_1", "all", exp + 1, &sig), "a longer lifetime");
        assert!(!a.verify_link("job_1", "all", exp, &sig.replace(&sig[..2], "00")), "a changed signature");
        assert!(!a.verify_link("job_1", "all", now() - 1, &sign(&a.link_key, &format!("dl|job_1|all|{}", now() - 1))), "an expired link");
        // a session token can't be used as a link, nor the other way round: the keys differ
        let (t, _) = a.session_token(&Access::new_visitor_id());
        assert!(!a.verify_link(&t, "all", exp, &sig));
    }
}
