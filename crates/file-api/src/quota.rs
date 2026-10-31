//! Who may start how much. Every counter is kept in memory, per visitor and per network address, so a restart forgets them:
//! good enough for one small server, and the reason they will move into a database when there is more than one.

use crate::config::TierLimits;
use crate::error::ApiError;
use crate::principal::{Principal, Tier};
use axum::http::StatusCode;
use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const HOUR: Duration = Duration::from_secs(3600);
/// More entries than this means something is wrong; refuse new visitors rather than grow without bound.
const MAX_ENTRIES: usize = 200_000;

fn utc_day() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() / 86_400).unwrap_or(0)
}

#[derive(Default)]
struct Entry {
    day: u64,
    bytes: u64,
    /// Starts of jobs in the last hour.
    jobs: VecDeque<Instant>,
    /// Uploads in flight right now.
    in_flight: usize,
    last_seen: Option<Instant>,
}

impl Entry {
    fn roll(&mut self) {
        let today = utc_day();
        if self.day != today {
            self.day = today;
            self.bytes = 0;
        }
        while self.jobs.front().is_some_and(|t| t.elapsed() >= HOUR) {
            self.jobs.pop_front();
        }
        self.last_seen = Some(Instant::now());
    }
}

#[derive(Default)]
struct Ledger {
    owners: HashMap<String, Entry>,
    ips: HashMap<IpAddr, Entry>,
    /// Sessions started per address in the last hour.
    mints: HashMap<IpAddr, VecDeque<Instant>>,
}

#[derive(Default, Clone)]
pub struct Quota {
    inner: Arc<Mutex<Ledger>>,
}

fn limited(code: &'static str, message: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::TOO_MANY_REQUESTS, code, message)
}

fn mb(n: u64) -> String {
    format!("{} MB", n / (1024 * 1024))
}

/// Holds a visitor's place while a file is uploading, and counts the bytes as they arrive.
pub struct Admission {
    quota: Quota,
    owner: String,
    ip: Option<IpAddr>,
    limits: TierLimits,
    enforced: bool,
}

impl Admission {
    /// Count `n` more uploaded bytes against the daily budgets. Fails once either budget is spent.
    pub fn add_bytes(&self, n: u64) -> Result<(), ApiError> {
        if !self.enforced {
            return Ok(());
        }
        let mut l = self.quota.inner.lock().unwrap();
        let owner = l.owners.entry(self.owner.clone()).or_default();
        owner.roll();
        owner.bytes = owner.bytes.saturating_add(n);
        let (used, over_owner) = (owner.bytes, self.limits.daily_bytes.is_some_and(|max| owner.bytes > max));
        let mut over_ip = false;
        if let Some(ip) = self.ip {
            let e = l.ips.entry(ip).or_default();
            e.roll();
            e.bytes = e.bytes.saturating_add(n);
            over_ip = self.limits.ip_daily_bytes.is_some_and(|max| e.bytes > max);
        }
        if over_owner {
            return Err(limited("DAILY_LIMIT", format!("You've reached today's limit of {}. It resets at midnight UTC.", mb(self.limits.daily_bytes.unwrap_or(used)))));
        }
        if over_ip {
            return Err(limited("DAILY_LIMIT", "This network has reached today's limit. It resets at midnight UTC."));
        }
        Ok(())
    }
}

impl Drop for Admission {
    fn drop(&mut self) {
        if !self.enforced {
            return;
        }
        let mut l = self.quota.inner.lock().unwrap();
        if let Some(e) = l.owners.get_mut(&self.owner) {
            e.in_flight = e.in_flight.saturating_sub(1);
        }
        if let Some(e) = self.ip.and_then(|ip| l.ips.get_mut(&ip)) {
            e.in_flight = e.in_flight.saturating_sub(1);
        }
    }
}

impl Quota {
    /// Let a visitor start an upload, or say why not. `active` is how many of their jobs (and, for the address, how many jobs
    /// from the same address) are already running; the upload in flight is counted here.
    pub fn admit(&self, who: &Principal, limits: &TierLimits, owner_active: usize, ip_active: usize, starts_job: bool) -> Result<Admission, ApiError> {
        let enforced = who.tier != Tier::Local;
        let adm = Admission { quota: self.clone(), owner: who.id.clone(), ip: who.ip, limits: limits.clone(), enforced };
        if !enforced {
            return Ok(adm);
        }
        let mut l = self.inner.lock().unwrap();
        if l.owners.len() + l.ips.len() > MAX_ENTRIES {
            return Err(ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "BUSY", "The service is very busy. Try again in a few minutes."));
        }
        let o = l.owners.entry(who.id.clone()).or_default();
        o.roll();
        if starts_job {
            if o.in_flight + owner_active >= limits.max_active_jobs {
                return Err(limited("TOO_MANY_JOBS", "You already have a job running. Wait for it to finish, then start the next one."));
            }
            if limits.jobs_per_hour.is_some_and(|max| o.jobs.len() as u32 >= max) {
                return Err(limited("RATE_LIMITED", "You've started a lot of jobs this hour. Try again in a little while."));
            }
        }
        if limits.daily_bytes.is_some_and(|max| o.bytes >= max) {
            return Err(limited("DAILY_LIMIT", format!("You've reached today's limit of {}. It resets at midnight UTC.", mb(limits.daily_bytes.unwrap_or(0)))));
        }
        if let Some(ip) = who.ip {
            let e = l.ips.entry(ip).or_default();
            e.roll();
            if starts_job {
                if limits.ip_active_jobs.is_some_and(|max| e.in_flight + ip_active >= max) {
                    return Err(limited("TOO_MANY_JOBS", "Too many jobs are running from your network. Try again in a minute."));
                }
                if limits.ip_jobs_per_hour.is_some_and(|max| e.jobs.len() as u32 >= max) {
                    return Err(limited("RATE_LIMITED", "Too many jobs have started from your network this hour. Try again in a little while."));
                }
            }
            if limits.ip_daily_bytes.is_some_and(|max| e.bytes >= max) {
                return Err(limited("DAILY_LIMIT", "This network has reached today's limit. It resets at midnight UTC."));
            }
            e.in_flight += 1;
            if starts_job {
                e.jobs.push_back(Instant::now());
            }
        }
        let o = l.owners.get_mut(&who.id).expect("inserted above");
        o.in_flight += 1;
        if starts_job {
            o.jobs.push_back(Instant::now());
        }
        Ok(adm)
    }

    /// May this address start another session? Starting one with a valid token (a refresh) never counts.
    pub fn allow_session(&self, ip: Option<IpAddr>, per_hour: u32) -> bool {
        let Some(ip) = ip else { return true };
        let mut l = self.inner.lock().unwrap();
        if l.mints.len() > MAX_ENTRIES {
            return false;
        }
        let q = l.mints.entry(ip).or_default();
        while q.front().is_some_and(|t| t.elapsed() >= HOUR) {
            q.pop_front();
        }
        if q.len() as u32 >= per_hour {
            return false;
        }
        q.push_back(Instant::now());
        true
    }

    /// What this visitor has used today (for the "you've used X of Y" line).
    pub fn usage(&self, who: &Principal) -> (u64, u32) {
        let mut l = self.inner.lock().unwrap();
        let o = l.owners.entry(who.id.clone()).or_default();
        o.roll();
        (o.bytes, o.jobs.len() as u32)
    }

    /// Forget visitors who have been quiet for two days. Called from the sweeper.
    pub fn prune(&self) {
        let mut l = self.inner.lock().unwrap();
        let old = |e: &Entry| e.in_flight == 0 && e.last_seen.is_none_or(|t| t.elapsed() > Duration::from_secs(2 * 86_400));
        l.owners.retain(|_, e| !old(e));
        l.ips.retain(|_, e| !old(e));
        l.mints.retain(|_, q| {
            while q.front().is_some_and(|t| t.elapsed() >= HOUR) {
                q.pop_front();
            }
            !q.is_empty()
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn who(id: &str, ip: &str) -> Principal {
        Principal { id: id.into(), tier: Tier::Anonymous, ip: ip.parse().ok() }
    }

    fn lim() -> TierLimits {
        TierLimits { max_active_jobs: 1, daily_bytes: Some(1000), jobs_per_hour: Some(3), ip_active_jobs: Some(2), ip_jobs_per_hour: Some(4), ip_daily_bytes: Some(1500), ..TierLimits::anonymous(100) }
    }

    #[test]
    fn one_job_at_a_time_per_visitor_and_released_on_drop() {
        let q = Quota::default();
        let a = who("a", "1.1.1.1");
        let first = q.admit(&a, &lim(), 0, 0, true).unwrap();
        assert_eq!(q.admit(&a, &lim(), 0, 0, true).err().unwrap().code, "TOO_MANY_JOBS", "second upload while the first is in flight");
        assert_eq!(q.admit(&a, &lim(), 1, 0, true).err().unwrap().code, "TOO_MANY_JOBS", "or while a job is processing");
        drop(first);
        q.admit(&a, &lim(), 0, 0, true).unwrap();
    }

    #[test]
    fn hourly_job_rate_and_address_limits() {
        let q = Quota::default();
        let l = TierLimits { max_active_jobs: 10, ..lim() };
        for _ in 0..3 {
            drop(q.admit(&who("a", "1.1.1.1"), &l, 0, 0, true).unwrap());
        }
        assert_eq!(q.admit(&who("a", "1.1.1.1"), &l, 0, 0, true).err().unwrap().code, "RATE_LIMITED");
        // another visitor behind the same address: the address allows 4 an hour in total, one already used by "a"'s 3 -> 1 left
        drop(q.admit(&who("b", "1.1.1.1"), &l, 0, 0, true).unwrap());
        assert_eq!(q.admit(&who("c", "1.1.1.1"), &l, 0, 0, true).err().unwrap().code, "RATE_LIMITED", "a fresh session doesn't escape the address limit");
        // a different address is unaffected
        drop(q.admit(&who("d", "2.2.2.2"), &l, 0, 0, true).unwrap());
        // concurrent jobs per address
        let x = q.admit(&who("e", "3.3.3.3"), &l, 0, 0, true).unwrap();
        let y = q.admit(&who("f", "3.3.3.3"), &l, 0, 0, true).unwrap();
        assert_eq!(q.admit(&who("g", "3.3.3.3"), &l, 0, 0, true).err().unwrap().code, "TOO_MANY_JOBS");
        drop((x, y));
    }

    #[test]
    fn daily_bytes_are_counted_as_they_arrive() {
        let q = Quota::default();
        let a = who("a", "1.1.1.1");
        let adm = q.admit(&a, &lim(), 0, 0, true).unwrap();
        adm.add_bytes(600).unwrap();
        assert_eq!(adm.add_bytes(500).err().unwrap().code, "DAILY_LIMIT", "1100 > 1000");
        drop(adm);
        assert_eq!(q.admit(&a, &lim(), 0, 0, true).err().unwrap().code, "DAILY_LIMIT", "and the day's budget stays spent");
        assert_eq!(q.usage(&a).0, 1100);
    }

    #[test]
    fn local_tier_is_never_limited() {
        let q = Quota::default();
        let l = Principal::local();
        let lim = TierLimits { max_active_jobs: 0, daily_bytes: Some(0), ..lim() };
        for _ in 0..5 {
            q.admit(&l, &lim, 99, 99, true).unwrap().add_bytes(u64::MAX / 2).unwrap();
        }
    }

    #[test]
    fn sessions_per_address_are_limited() {
        let q = Quota::default();
        let ip = "9.9.9.9".parse().ok();
        assert!(q.allow_session(ip, 2) && q.allow_session(ip, 2));
        assert!(!q.allow_session(ip, 2));
        assert!(q.allow_session("8.8.8.8".parse().ok(), 2));
        assert!(q.allow_session(None, 0), "no address known (local use): not limited");
    }
}
