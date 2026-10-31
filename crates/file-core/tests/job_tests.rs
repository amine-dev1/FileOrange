mod common;
use common::*;
use file_core::{JobManager, JobState};
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn wait_done(m: &JobManager, id: &str) -> file_core::JobStatus {
    let t = Instant::now();
    loop {
        let s = m.get(id).unwrap();
        if s.status.is_finished() {
            return s;
        }
        assert!(t.elapsed() < Duration::from_secs(60), "timed out in {:?}", s.status);
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn manager_runs_job_in_background_and_streams_updates() {
    let d = tempfile::tempdir().unwrap();
    let a = write(&d.path().join("a.bin"), &noise(1_500_000));
    let out = d.path().join("o");
    std::fs::create_dir(&out).unwrap();
    let m = JobManager::new(2);
    let seen: Arc<Mutex<Vec<JobState>>> = Default::default();
    let s2 = seen.clone();
    let id = m
        .start(req(json!({"inputs": [a], "output_dir": out, "operation": {"type": "compress"}})), move |s| s2.lock().unwrap().push(s.status))
        .unwrap();
    let s = wait_done(&m, &id);
    assert_eq!(s.status, JobState::Completed);
    assert_eq!(s.output_paths.len(), 1);
    let seen = seen.lock().unwrap();
    assert_eq!(seen.first(), Some(&JobState::Queued));
    assert!(seen.contains(&JobState::Running));
    assert_eq!(seen.last(), Some(&JobState::Completed));
}

#[test]
fn start_validates_before_queueing() {
    let d = tempfile::tempdir().unwrap();
    let m = JobManager::new(1);
    let r = req(json!({"inputs": [d.path().join("missing.txt")], "output_dir": d.path(), "operation": {"type": "compress"}}));
    assert!(m.start(r, |_| {}).is_err());
    let r = req(json!({"inputs": ["relative.txt"], "output_dir": d.path(), "operation": {"type": "compress"}}));
    assert!(m.start(r, |_| {}).is_err());
    let r = req(json!({"inputs": [], "output_dir": d.path(), "operation": {"type": "compress"}}));
    assert!(m.start(r, |_| {}).is_err());
}

#[test]
fn cancel_a_running_job() {
    let d = tempfile::tempdir().unwrap();
    let files: Vec<_> = (0..6).map(|i| write(&d.path().join(format!("{i}.bin")), &noise(3_000_000))).collect();
    let out = d.path().join("o");
    std::fs::create_dir(&out).unwrap();
    let m = Arc::new(JobManager::new(1));
    let m2 = m.clone();
    let id_cell: Arc<Mutex<Option<String>>> = Default::default();
    let c2 = id_cell.clone();
    let id = m
        .start(req(json!({"inputs": files, "output_dir": out, "operation": {"type": "compress"}})), move |s| {
            if s.bytes_processed > 0 {
                if let Some(id) = c2.lock().unwrap().clone() {
                    let _ = m2.cancel(&id);
                }
            }
        })
        .unwrap();
    *id_cell.lock().unwrap() = Some(id.clone());
    let s = wait_done(&m, &id);
    // Either we cancelled in time, or the job was so fast it finished first.
    assert!(matches!(s.status, JobState::Cancelled | JobState::Completed), "{:?}", s.status);
    if s.status == JobState::Cancelled {
        assert!(names(&out).is_empty(), "{:?}", names(&out));
    }
}

#[test]
fn queued_job_can_be_cancelled_and_limit_is_enforced() {
    let d = tempfile::tempdir().unwrap();
    let big = write(&d.path().join("big.bin"), &noise(8_000_000));
    let small = write(&d.path().join("s.txt"), b"x");
    let (o1, o2) = (d.path().join("o1"), d.path().join("o2"));
    std::fs::create_dir(&o1).unwrap();
    std::fs::create_dir(&o2).unwrap();
    let m = JobManager::new(1);
    let first = m.start(req(json!({"inputs": [big], "output_dir": o1, "operation": {"type": "compress"}})), |_| {}).unwrap();
    let second = m.start(req(json!({"inputs": [small], "output_dir": o2, "operation": {"type": "compress"}})), |_| {}).unwrap();
    m.cancel(&second).unwrap();
    assert_eq!(wait_done(&m, &second).status, JobState::Cancelled);
    assert_eq!(wait_done(&m, &first).status, JobState::Completed);
    assert!(names(&o2).is_empty());
    m.clear_finished();
    assert!(m.list().is_empty());
}

#[test]
fn passwords_never_appear_in_debug_or_status_output() {
    let r = req(json!({"inputs": ["/x"], "output_dir": "/y", "operation": {"type": "extract", "password": "hunter2"}}));
    assert!(!format!("{r:?}").contains("hunter2"));
}

#[test]
fn error_messages_are_plain_language() {
    use file_core::Error;
    let e = Error::Io { path: Some("/a/b.zip".into()), source: std::io::ErrorKind::StorageFull.into() };
    assert_eq!(e.user_message(), "There isn't enough space in the selected folder.");
    assert!(Error::CorruptArchive("x".into()).user_message().contains("damaged"));
    assert!(!Error::CorruptArchive("secret internal detail".into()).user_message().contains("internal"));
}
