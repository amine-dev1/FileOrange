mod common;
use common::*;
use file_core::archive;
use serde_json::json;
use std::fs;

fn compress_req(inputs: &[&std::path::Path], out: &std::path::Path, extra: serde_json::Value) -> file_core::JobRequest {
    let mut op = json!({"type": "compress"});
    op.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    req(json!({"inputs": inputs, "output_dir": out, "operation": op}))
}

#[test]
fn compress_then_extract_roundtrip_with_nested_folder_and_unicode() {
    let d = tempfile::tempdir().unwrap();
    let src = d.path().join("données été");
    write(&src.join("a.txt"), b"hello");
    write(&src.join("sub/日本語 file.txt"), &noise(300_000));
    fs::create_dir_all(src.join("empty")).unwrap();
    let single = write(&d.path().join("single.bin"), b"x");
    let out = d.path().join("out dir");
    fs::create_dir(&out).unwrap();

    let s = run(&compress_req(&[&src, &single], &out, json!({"archive_name": "bundle"})));
    assert_eq!(s.error_code, None);
    let zip_path = out.join("bundle.zip");
    assert!(zip_path.exists());
    assert_eq!(s.files_total, 3);
    assert_eq!(s.files_completed, 3);

    let listing = archive::list(&zip_path).unwrap();
    let entry_names: Vec<_> = listing.entries.iter().map(|e| e.name.as_str()).collect();
    assert!(entry_names.contains(&"données été/a.txt"));
    assert!(entry_names.contains(&"données été/sub/日本語 file.txt"));
    assert!(entry_names.contains(&"données été/empty/"));
    assert!(entry_names.contains(&"single.bin"));

    let dest = d.path().join("extracted");
    fs::create_dir(&dest).unwrap();
    let s = run(&req(json!({"inputs": [zip_path], "output_dir": dest, "operation": {"type": "extract", "subfolder": false}})));
    assert_eq!(s.error_code, None);
    assert_eq!(fs::read(dest.join("données été/a.txt")).unwrap(), b"hello");
    assert_eq!(fs::read(dest.join("données été/sub/日本語 file.txt")).unwrap(), noise(300_000));
    assert!(dest.join("données été/empty").is_dir());
    // sources untouched
    assert_eq!(fs::read(src.join("a.txt")).unwrap(), b"hello");
    // no temp files left behind
    assert!(names_recursive(&dest).iter().all(|n| !n.ends_with(".part")));
    assert!(names(&out).iter().all(|n| !n.ends_with(".part")));
}

fn names_recursive(p: &std::path::Path) -> Vec<String> {
    walk(p)
}
fn walk(p: &std::path::Path) -> Vec<String> {
    let mut v = vec![];
    for e in fs::read_dir(p).unwrap() {
        let e = e.unwrap();
        v.push(e.file_name().to_string_lossy().into_owned());
        if e.path().is_dir() {
            v.extend(walk(&e.path()));
        }
    }
    v
}

#[test]
fn folder_requires_include_folders() {
    let d = tempfile::tempdir().unwrap();
    let dir = d.path().join("f");
    write(&dir.join("a"), b"1");
    let r = compress_req(&[&dir], d.path(), json!({"include_folders": false}));
    assert!(file_core::request::validate(&r).is_err());
}

#[test]
fn path_traversal_archive_is_rejected_and_nothing_is_written() {
    let d = tempfile::tempdir().unwrap();
    let z = d.path().join("evil.zip");
    raw_zip(&z, &[("fine.txt", b"ok"), ("../../outside.txt", b"pwned")]);
    let dest = d.path().join("a/b");
    fs::create_dir_all(&dest).unwrap();

    let listing = archive::list(&z).unwrap();
    assert_eq!(listing.unsafe_entries, 1);

    let s = run(&req(json!({"inputs": [z], "output_dir": dest, "operation": {"type": "extract", "subfolder": false}})));
    assert_eq!(s.results.len(), 1);
    assert_eq!(s.results[0].error_code.as_deref(), Some("unsafe_entry"));
    assert!(!d.path().join("outside.txt").exists());
    assert!(!d.path().join("a/outside.txt").exists());
    assert!(!dest.join("fine.txt").exists(), "validation happens before any write");
    assert!(names(&dest).is_empty());
}

#[test]
fn absolute_and_backslash_traversal_rejected() {
    let d = tempfile::tempdir().unwrap();
    for (i, name) in ["/tmp/abs.txt", "..\\..\\win.txt", "C:\\x.txt"].iter().enumerate() {
        let z = d.path().join(format!("e{i}.zip"));
        raw_zip(&z, &[(name, b"x")]);
        let dest = d.path().join(format!("d{i}"));
        fs::create_dir(&dest).unwrap();
        let s = run(&req(json!({"inputs": [z], "output_dir": dest, "operation": {"type": "extract", "subfolder": false}})));
        assert_eq!(s.results[0].error_code.as_deref(), Some("unsafe_entry"), "{name}");
    }
}

#[test]
fn damaged_and_truncated_archives_fail_safely_in_a_batch() {
    let d = tempfile::tempdir().unwrap();
    let good_src = write(&d.path().join("g.txt"), b"good");
    let out = d.path().join("o");
    fs::create_dir(&out).unwrap();
    run(&compress_req(&[&good_src], &out, json!({"archive_name": "good"})));
    let good = out.join("good.zip");

    let garbage = write(&d.path().join("garbage.zip"), b"this is not a zip file at all");
    let bytes = fs::read(&good).unwrap();
    let truncated = write(&d.path().join("trunc.zip"), &bytes[..bytes.len() / 2]);

    let dest = d.path().join("dest");
    fs::create_dir(&dest).unwrap();
    let s = run(&req(json!({"inputs": [garbage, good, truncated], "output_dir": dest, "operation": {"type": "extract"}})));
    assert_eq!(s.results.len(), 3, "every file reports a result");
    assert_eq!(s.results[0].error_code.as_deref(), Some("corrupt_archive"));
    assert_eq!(s.results[1].outcome, file_core::Outcome::Done);
    assert_eq!(s.results[2].error_code.as_deref(), Some("corrupt_archive"));
    assert_eq!(fs::read(dest.join("good/g.txt")).unwrap(), b"good");
}

#[test]
fn corrupted_data_inside_entry_is_reported_as_damaged() {
    let d = tempfile::tempdir().unwrap();
    let src = write(&d.path().join("big.bin"), &noise(100_000));
    let out = d.path().join("o");
    fs::create_dir(&out).unwrap();
    run(&compress_req(&[&src], &out, json!({"archive_name": "x"})));
    let z = out.join("x.zip");
    let mut bytes = fs::read(&z).unwrap();
    bytes[2000] ^= 0xFF; // flip bits in the compressed payload
    fs::write(&z, bytes).unwrap();
    let dest = d.path().join("dest");
    fs::create_dir(&dest).unwrap();
    let s = run(&req(json!({"inputs": [z], "output_dir": dest, "operation": {"type": "extract", "subfolder": false}})));
    assert_eq!(s.results[0].error_code.as_deref(), Some("corrupt_archive"));
    assert!(names(&dest).iter().all(|n| !n.ends_with(".part")), "temp cleaned: {:?}", names(&dest));
}

#[test]
fn conflict_policies_on_extract() {
    let d = tempfile::tempdir().unwrap();
    let z = d.path().join("a.zip");
    raw_zip(&z, &[("f.txt", b"from zip")]);
    let dest = d.path().join("dest");
    write(&dest.join("f.txt"), b"original");

    let go = |policy: &str| run(&req(json!({"inputs": [&z], "output_dir": &dest, "conflict": policy, "operation": {"type": "extract", "subfolder": false}})));

    go("skip");
    assert_eq!(fs::read(dest.join("f.txt")).unwrap(), b"original");
    go("rename");
    assert_eq!(fs::read(dest.join("f.txt")).unwrap(), b"original");
    assert_eq!(fs::read(dest.join("f (1).txt")).unwrap(), b"from zip");
    go("replace");
    assert_eq!(fs::read(dest.join("f.txt")).unwrap(), b"from zip");
}

#[test]
fn default_policy_never_overwrites() {
    let d = tempfile::tempdir().unwrap();
    let src = write(&d.path().join("a.txt"), b"1");
    let out = d.path().join("o");
    write(&out.join("a.zip"), b"precious");
    run(&compress_req(&[&src], &out, json!({})));
    assert_eq!(fs::read(out.join("a.zip")).unwrap(), b"precious");
    assert!(out.join("a (1).zip").exists());
}

#[test]
fn compressing_a_zip_into_its_own_folder_does_not_replace_it() {
    let d = tempfile::tempdir().unwrap();
    let z = d.path().join("a.zip");
    raw_zip(&z, &[("f", b"x")]);
    let before = fs::read(&z).unwrap();
    let r = compress_req(&[&z], d.path(), json!({"archive_name": "a.zip"}));
    let mut r2 = r.clone();
    r2.conflict = file_core::ConflictPolicy::Replace;
    let s = run(&r2);
    assert_eq!(s.error_code.as_deref(), Some("would_overwrite_source"));
    assert_eq!(fs::read(&z).unwrap(), before);
}

#[test]
fn output_folder_inside_input_folder_does_not_include_itself() {
    let d = tempfile::tempdir().unwrap();
    let src = d.path().join("proj");
    write(&src.join("a.txt"), b"1");
    let s = run(&compress_req(&[&src], &src, json!({"archive_name": "proj"})));
    assert_eq!(s.error_code, None);
    let l = archive::list(&src.join("proj.zip")).unwrap();
    assert_eq!(l.entries.iter().filter(|e| !e.is_dir).count(), 1);
}

#[test]
fn zip_bomb_limits() {
    let d = tempfile::tempdir().unwrap();
    let z = d.path().join("bomb.zip");
    raw_zip(&z, &[("zeros.bin", &vec![0u8; 5_000_000])]);
    let dest = d.path().join("dest");
    fs::create_dir(&dest).unwrap();
    let s = run(&req(json!({"inputs": [&z], "output_dir": &dest, "operation": {"type": "extract", "max_total_bytes": 1_000_000}})));
    assert_eq!(s.results[0].error_code.as_deref(), Some("expansion_limit"));
    assert!(walk(&dest).iter().all(|n| !n.ends_with(".part") && n != "zeros.bin"));
}

#[test]
fn password_protected_archive_is_reported() {
    // Hand-crafted: flip the "encrypted" general-purpose bit on a stored entry.
    let d = tempfile::tempdir().unwrap();
    let z = d.path().join("p.zip");
    raw_zip(&z, &[("secret.txt", b"data")]);
    let mut b = fs::read(&z).unwrap();
    // local header GP flag at offset 6, central directory flag at +8 from its signature
    b[6] |= 1;
    let cd = b.windows(4).position(|w| w == [0x50, 0x4b, 0x01, 0x02]).unwrap();
    b[cd + 8] |= 1;
    fs::write(&z, &b).unwrap();
    assert!(archive::list(&z).unwrap().needs_password);
    let dest = d.path().join("dest");
    fs::create_dir(&dest).unwrap();
    let s = run(&req(json!({"inputs": [&z], "output_dir": &dest, "operation": {"type": "extract"}})));
    assert_eq!(s.results[0].error_code.as_deref(), Some("password_required"));
}

#[test]
fn cancellation_mid_compress_leaves_no_files() {
    let d = tempfile::tempdir().unwrap();
    let a = write(&d.path().join("a.bin"), &noise(2_000_000));
    let b = write(&d.path().join("b.bin"), &noise(2_000_000));
    let out = d.path().join("o");
    fs::create_dir(&out).unwrap();
    let r = compress_req(&[&a, &b], &out, json!({}));
    let (status, err) = run_with_cancel_after_first_progress(&r);
    assert_eq!(err.as_deref(), Some("cancelled"));
    assert!(status.bytes_processed < 4_000_000);
    assert!(names(&out).is_empty(), "left behind: {:?}", names(&out));
    assert_eq!(fs::read(&a).unwrap().len(), 2_000_000);
}

#[test]
fn review_reports_conflicts_and_blocking_errors() {
    let d = tempfile::tempdir().unwrap();
    let z = d.path().join("evil.zip");
    raw_zip(&z, &[("../x", b"1")]);
    let dest = d.path().join("dest");
    fs::create_dir(&dest).unwrap();
    let r = file_core::request::review(&req(json!({"inputs": [z], "output_dir": dest, "operation": {"type": "extract"}}))).unwrap();
    assert_eq!(r.errors.len(), 1);

    let src = write(&d.path().join("a.txt"), b"1");
    write(&dest.join("a.zip"), b"x");
    let r = file_core::request::review(&compress_req(&[&src], &dest, json!({}))).unwrap();
    assert_eq!(r.conflicts, vec![dest.join("a.zip")]);
}
