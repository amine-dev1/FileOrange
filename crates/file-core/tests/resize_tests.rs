//! Resize and compress: sizes, target file size, keeping each picture's own format.
mod common;
use common::*;
use file_core::Outcome;
use serde_json::json;
use std::fs;

fn resize(inputs: Vec<std::path::PathBuf>, out: &std::path::Path, opts: serde_json::Value) -> file_core::JobStatus {
    let mut op = json!({"type": "resize_image"});
    op.as_object_mut().unwrap().extend(opts.as_object().unwrap().clone());
    run(&req(json!({"inputs": inputs, "output_dir": out, "operation": op})))
}

fn noisy_png(path: &std::path::Path, w: u32, h: u32) -> std::path::PathBuf {
    let n = noise((w * h * 3) as usize);
    let img = image::RgbImage::from_fn(w, h, |x, y| {
        let i = ((y * w + x) * 3) as usize;
        image::Rgb([n[i], n[i + 1], n[i + 2]])
    });
    img.save(path).unwrap();
    path.to_path_buf()
}

fn dims(p: &std::path::Path) -> (u32, u32) {
    let i = image::open(p).unwrap();
    (i.width(), i.height())
}

#[test]
fn percentage_scales_both_sides_and_keeps_each_format() {
    let d = tempfile::tempdir().unwrap();
    let a = png(&d.path().join("a.png"), 200, 100, true);
    let b = d.path().join("b.jpg");
    image::DynamicImage::ImageRgb8(photo(300, 150)).save(&b).unwrap();
    let out = d.path().join("out");
    fs::create_dir(&out).unwrap();

    let s = resize(vec![a, b], &out, json!({"format": "keep", "resize_mode": "percent", "resize_percent": 50}));
    assert!(s.results.iter().all(|r| r.outcome == Outcome::Done), "{:?}", s.results);
    assert_eq!(dims(&out.join("a.png")), (100, 50));
    assert_eq!(dims(&out.join("b.jpg")), (150, 75));
    assert_eq!(image::guess_format(&fs::read(out.join("a.png")).unwrap()).unwrap(), image::ImageFormat::Png, "PNG stays PNG");
    assert!(image::open(out.join("a.png")).unwrap().color().has_alpha(), "and keeps its transparency");
    assert!(s.results[0].message.as_deref().unwrap().contains("200×100 to 100×50"), "{:?}", s.results[0].message);
}

#[test]
fn fit_keeps_proportions_and_never_enlarges() {
    let d = tempfile::tempdir().unwrap();
    let wide = png(&d.path().join("wide.png"), 400, 200, false);
    let small = png(&d.path().join("small.png"), 50, 40, false);
    let out = d.path().join("out");
    fs::create_dir(&out).unwrap();

    let s = resize(vec![wide, small], &out, json!({"format": "keep", "resize_mode": "fit", "max_width": 100, "max_height": 100}));
    assert!(s.results.iter().all(|r| r.outcome == Outcome::Done), "{:?}", s.results);
    assert_eq!(dims(&out.join("wide.png")), (100, 50));
    assert_eq!(dims(&out.join("small.png")), (50, 40), "smaller pictures are left at their size");
    assert!(s.results[1].message.is_none(), "nothing to say about a picture that wasn't resized");

    // one side only
    let only_h = d.path().join("only_h");
    fs::create_dir(&only_h).unwrap();
    resize(vec![d.path().join("wide.png")], &only_h, json!({"format": "keep", "resize_mode": "fit", "max_height": 50}));
    assert_eq!(dims(&only_h.join("wide.png")), (100, 50));
}

#[test]
fn target_size_finds_a_quality_that_fits() {
    let d = tempfile::tempdir().unwrap();
    let src = noisy_png(&d.path().join("n.png"), 400, 400);
    let out = d.path().join("out");
    fs::create_dir(&out).unwrap();

    let s = resize(vec![src.clone()], &out, json!({"format": "jpeg", "resize_mode": "none", "target_kb": 60, "quality": 95}));
    assert_eq!(s.results[0].outcome, Outcome::Done, "{:?}", s.results);
    let size = fs::metadata(out.join("n.jpg")).unwrap().len();
    assert!(size <= 60_000, "{size} bytes");
    let msg = s.results[0].message.as_deref().unwrap();
    assert!(msg.starts_with("Quality ") && msg.contains("under 60 KB"), "{msg}");

    // the best quality that fits: one step higher would not fit
    let q: u8 = msg.trim_start_matches("Quality ").split(' ').next().unwrap().parse().unwrap();
    let above = d.path().join("above");
    fs::create_dir(&above).unwrap();
    resize(vec![src.clone()], &above, json!({"format": "jpeg", "resize_mode": "none", "quality": q + 1}));
    assert!(fs::metadata(above.join("n.jpg")).unwrap().len() > 60_000, "quality {} would have been too big", q + 1);

    // a target already met keeps the chosen quality
    let easy = d.path().join("easy");
    fs::create_dir(&easy).unwrap();
    let s = resize(vec![src.clone()], &easy, json!({"format": "webp", "resize_mode": "none", "target_kb": 100000, "quality": 70}));
    assert!(s.results[0].message.as_deref().unwrap().starts_with("Quality 70 "), "{:?}", s.results[0].message);

    // impossible: says so, still makes the smallest it can
    let tiny = d.path().join("tiny");
    fs::create_dir(&tiny).unwrap();
    let s = resize(vec![src], &tiny, json!({"format": "jpeg", "resize_mode": "none", "target_kb": 1}));
    assert_eq!(s.results[0].outcome, Outcome::Done);
    assert!(s.results[0].message.as_deref().unwrap().contains("Couldn't get under 1 KB"), "{:?}", s.results[0].message);
}

#[test]
fn bad_sizes_are_refused_before_anything_runs() {
    let reg = file_core::engine::Registry::bundled();
    let check = |opts: serde_json::Value| {
        let mut op = json!({"type": "resize_image"});
        op.as_object_mut().unwrap().extend(opts.as_object().unwrap().clone());
        let op: file_core::Operation = serde_json::from_value(op).unwrap();
        let f = file_core::formats::FileDescriptor { name: "a.png".into(), size: 10, format: Some("png".into()) };
        reg.engine_for("resize_image").unwrap().preflight(&op, &[f], true)
    };
    assert!(check(json!({"format": "keep", "resize_mode": "percent", "resize_percent": 50})).is_ok());
    assert!(check(json!({"format": "keep", "resize_mode": "percent", "resize_percent": 0})).is_err());
    assert!(check(json!({"format": "keep", "resize_mode": "percent", "resize_percent": 101})).is_err());
    assert!(check(json!({"format": "keep", "resize_mode": "fit"})).is_err(), "fit needs at least one side");
    assert!(check(json!({"format": "keep", "resize_mode": "fit", "max_width": 40000})).is_err());
    assert!(check(json!({"format": "png", "resize_mode": "none", "target_kb": 2000000})).is_err());
}
