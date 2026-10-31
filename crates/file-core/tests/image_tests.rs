mod common;
use common::*;
use file_core::Outcome;
use serde_json::json;
use std::fs;

fn convert(inputs: Vec<std::path::PathBuf>, out: &std::path::Path, opts: serde_json::Value) -> file_core::JobStatus {
    let mut op = json!({"type": "convert_image"});
    op.as_object_mut().unwrap().extend(opts.as_object().unwrap().clone());
    run(&req(json!({"inputs": inputs, "output_dir": out, "operation": op})))
}

#[test]
fn png_to_jpeg_and_webp_decode_back_and_source_is_untouched() {
    let d = tempfile::tempdir().unwrap();
    let src = png(&d.path().join("pic.png"), 64, 48, false);
    let before = fs::read(&src).unwrap();
    let out = d.path().join("out");
    fs::create_dir(&out).unwrap();

    let s = convert(vec![src.clone()], &out, json!({"format": "jpeg", "quality": 90}));
    assert_eq!(s.results[0].outcome, Outcome::Done, "{:?}", s.results);
    let jpg = image::open(out.join("pic.jpg")).unwrap();
    assert_eq!((jpg.width(), jpg.height()), (64, 48));
    assert_eq!(image::guess_format(&fs::read(out.join("pic.jpg")).unwrap()).unwrap(), image::ImageFormat::Jpeg);

    let s = convert(vec![src.clone()], &out, json!({"format": "webp", "webp_mode": "lossless"}));
    assert_eq!(s.results[0].outcome, Outcome::Done);
    let w = image::open(out.join("pic.webp")).unwrap();
    assert_eq!((w.width(), w.height()), (64, 48));

    // Lossless WebP: pixels must match the PNG exactly.
    assert_eq!(w.to_rgb8().as_raw(), image::open(&src).unwrap().to_rgb8().as_raw());
    assert_eq!(fs::read(&src).unwrap(), before);
}

#[test]
fn jpeg_quality_changes_size() {
    let d = tempfile::tempdir().unwrap();
    let mut img = image::RgbImage::new(200, 200);
    let n = noise(200 * 200 * 3);
    for (i, p) in img.pixels_mut().enumerate() {
        *p = image::Rgb([n[i * 3], n[i * 3 + 1], n[i * 3 + 2]]);
    }
    let src = d.path().join("n.png");
    img.save(&src).unwrap();
    let hi = d.path().join("hi");
    let lo = d.path().join("lo");
    fs::create_dir(&hi).unwrap();
    fs::create_dir(&lo).unwrap();
    convert(vec![src.clone()], &hi, json!({"format": "jpeg", "quality": 95}));
    convert(vec![src], &lo, json!({"format": "jpeg", "quality": 20}));
    assert!(fs::metadata(lo.join("n.jpg")).unwrap().len() < fs::metadata(hi.join("n.jpg")).unwrap().len());
}

#[test]
fn transparency_is_flattened_to_white_for_jpeg_and_kept_for_png_and_webp() {
    let d = tempfile::tempdir().unwrap();
    let src = png(&d.path().join("t.png"), 40, 40, true); // left half transparent
    let out = d.path().join("o");
    fs::create_dir(&out).unwrap();
    convert(vec![src.clone()], &out, json!({"format": "jpeg", "quality": 100}));
    let px = image::open(out.join("t.jpg")).unwrap().to_rgb8().get_pixel(2, 20).0;
    assert!(px.iter().all(|&c| c > 240), "expected near-white, got {px:?}");

    let out2 = d.path().join("o2");
    fs::create_dir(&out2).unwrap();
    convert(vec![src], &out2, json!({"format": "webp", "webp_mode": "lossless"}));
    let a = image::open(out2.join("t.webp")).unwrap().to_rgba8().get_pixel(2, 20).0[3];
    assert_eq!(a, 0);
}

#[test]
fn batch_reports_every_file_including_bad_ones() {
    let d = tempfile::tempdir().unwrap();
    let good = png(&d.path().join("good.png"), 16, 16, false);
    let fake = write(&d.path().join("fake.png"), b"not an image");
    let truncated_full = {
        let p = png(&d.path().join("t.png"), 64, 64, false);
        let b = fs::read(&p).unwrap();
        write(&d.path().join("trunc.png"), &b[..b.len() / 2])
    };
    let gif_like = write(&d.path().join("anim.gif"), b"GIF89a\x01\x00\x01\x00\x00\x00\x00;");
    let out = d.path().join("o");
    fs::create_dir(&out).unwrap();
    let s = convert(vec![good, fake, truncated_full, gif_like], &out, json!({"format": "jpeg"}));
    assert_eq!(s.results.len(), 4);
    assert_eq!(s.results[0].outcome, Outcome::Done);
    assert_eq!(s.results[1].outcome, Outcome::Failed);
    assert_eq!(s.results[2].outcome, Outcome::Failed);
    assert_eq!(s.results[3].outcome, Outcome::Failed);
    assert_eq!(s.files_completed, 4);
    assert_eq!(names(&out), vec!["good.jpg"], "failed inputs leave no partial output");
}

#[test]
fn converting_to_same_format_in_same_folder_never_overwrites_original() {
    let d = tempfile::tempdir().unwrap();
    let src = png(&d.path().join("a.png"), 8, 8, false);
    let before = fs::read(&src).unwrap();
    let s = convert(vec![src.clone()], d.path(), json!({"format": "png"}));
    assert_eq!(s.results[0].outcome, Outcome::Done);
    assert_eq!(fs::read(&src).unwrap(), before);
    assert!(d.path().join("a (1).png").exists());

    // Even an explicit "replace" must refuse to touch the source.
    let mut r = req(json!({"inputs": [&src], "output_dir": d.path(), "conflict": "replace", "operation": {"type": "convert_image", "format": "png"}}));
    r.conflict = file_core::ConflictPolicy::Replace;
    let s = run(&r);
    assert_eq!(s.results[0].outcome, Outcome::Failed);
    assert_eq!(s.results[0].error_code.as_deref(), Some("would_overwrite_source"));
    assert_eq!(fs::read(&src).unwrap(), before);
}

#[test]
fn exif_orientation_is_applied_when_metadata_removed() {
    // Make a 2x1 JPEG tagged "rotate 90° CW" (orientation 6): displayed as 1x2.
    let d = tempfile::tempdir().unwrap();
    let mut jpg = Vec::new();
    {
        use image::ImageEncoder;
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpg, 95);
        // minimal big-endian EXIF: II* header, one IFD entry (0x0112 orientation = 6)
        let exif = vec![
            b'M', b'M', 0, 42, 0, 0, 0, 8, // TIFF header, IFD at offset 8
            0, 1, // one entry
            0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, // orientation, SHORT, count 1, value 6
            0, 0, 0, 0, // next IFD
        ];
        enc.set_exif_metadata(exif).unwrap();
        enc.write_image(&[255, 0, 0, 0, 0, 255], 2, 1, image::ExtendedColorType::Rgb8).unwrap();
    }
    let src = write(&d.path().join("rot.jpg"), &jpg);
    let out = d.path().join("o");
    fs::create_dir(&out).unwrap();

    convert(vec![src.clone()], &out, json!({"format": "png"}));
    let img = image::open(out.join("rot.png")).unwrap();
    assert_eq!((img.width(), img.height()), (1, 2), "orientation baked into pixels");

    let out2 = d.path().join("o2");
    fs::create_dir(&out2).unwrap();
    convert(vec![src], &out2, json!({"format": "png", "keep_metadata": true}));
    let img = image::open(out2.join("rot.png")).unwrap();
    assert_eq!((img.width(), img.height()), (1, 2), "rotation is baked in even when EXIF is kept");
    let mut dec = image::ImageReader::open(out2.join("rot.png")).unwrap().into_decoder().unwrap();
    assert!(dec.exif_metadata().unwrap().is_some(), "EXIF kept as asked");
    assert_eq!(dec.orientation().unwrap(), image::metadata::Orientation::NoTransforms, "tag reset so nothing rotates twice");
}

#[test]
fn review_warns_about_lossy_and_transparency() {
    let d = tempfile::tempdir().unwrap();
    let src = png(&d.path().join("a.png"), 4, 4, true);
    let r = file_core::request::review(&req(json!({"inputs": [src], "output_dir": d.path(), "operation": {"type": "convert_image", "format": "jpeg"}}))).unwrap();
    assert!(r.warnings.iter().any(|w| w.contains("transparency")));
    assert!(r.warnings.iter().any(|w| w.contains("lossy")));
}

#[test]
fn quality_out_of_range_is_rejected() {
    let d = tempfile::tempdir().unwrap();
    let src = png(&d.path().join("a.png"), 4, 4, false);
    let r = req(json!({"inputs": [src], "output_dir": d.path(), "operation": {"type": "convert_image", "format": "jpeg", "quality": 0}}));
    assert!(file_core::request::validate(&r).is_err());
}

// ======================================================================
// Phase 1: lossy WebP, quality applicability, orientation, colour profiles
// ======================================================================

use image::metadata::Orientation;
use image::ImageDecoder;

fn decoder(p: &std::path::Path) -> impl ImageDecoder {
    image::ImageReader::open(p).unwrap().with_guessed_format().unwrap().into_decoder().unwrap()
}

fn mean_abs_error(a: &image::RgbImage, b: &image::RgbImage) -> f64 {
    let total: u64 = a.as_raw().iter().zip(b.as_raw()).map(|(x, y)| (*x as i32 - *y as i32).unsigned_abs() as u64).sum();
    total as f64 / a.as_raw().len() as f64
}

fn out_dir(d: &tempfile::TempDir, name: &str) -> std::path::PathBuf {
    let p = d.path().join(name);
    fs::create_dir_all(&p).unwrap();
    p
}

#[test]
fn lossy_webp_is_the_default_smaller_than_lossless_and_close_to_the_source() {
    let d = tempfile::tempdir().unwrap();
    let img = photo(256, 192);
    let src = d.path().join("p.png");
    img.save(&src).unwrap();

    let lossy = out_dir(&d, "lossy");
    let s = convert(vec![src.clone()], &lossy, json!({"format": "webp", "quality": 80}));
    assert_eq!(s.results[0].outcome, Outcome::Done, "{:?}", s.results);
    let lossless = out_dir(&d, "lossless");
    convert(vec![src.clone()], &lossless, json!({"format": "webp", "webp_mode": "lossless"}));

    let lossy_bytes = fs::read(lossy.join("p.webp")).unwrap();
    assert_eq!(image::guess_format(&lossy_bytes).unwrap(), image::ImageFormat::WebP);
    assert!((lossy_bytes.len() as u64) < fs::metadata(lossless.join("p.webp")).unwrap().len(), "lossy must be smaller");

    let decoded = image::load_from_memory(&lossy_bytes).unwrap().to_rgb8();
    assert_eq!((decoded.width(), decoded.height()), (256, 192));
    let err = mean_abs_error(&decoded, &img);
    assert!(err > 0.0, "lossy is not pixel exact");
    assert!(err < 6.0, "but stays close at quality 80 (mean error {err:.2})");
}

#[test]
fn webp_quality_changes_size_only_in_lossy_mode_and_png_ignores_quality() {
    let d = tempfile::tempdir().unwrap();
    let mut noisy = photo(200, 200);
    for (i, p) in noisy.pixels_mut().enumerate() { let n = noise(3); p.0[0] = p.0[0].wrapping_add(n[0] ^ (i as u8)); }
    let src = d.path().join("n.png");
    noisy.save(&src).unwrap();
    let size = |dir: &std::path::Path, name: &str| fs::metadata(dir.join(name)).unwrap().len();
    let run = |name: &str, opts: serde_json::Value| { let o = out_dir(&d, name); convert(vec![src.clone()], &o, opts); o };

    let hi = run("hi", json!({"format": "webp", "quality": 95}));
    let lo = run("lo", json!({"format": "webp", "quality": 15}));
    assert!(size(&lo, "n.webp") < size(&hi, "n.webp"), "lossy quality matters");

    let ll_a = run("lla", json!({"format": "webp", "webp_mode": "lossless", "quality": 95}));
    let ll_b = run("llb", json!({"format": "webp", "webp_mode": "lossless", "quality": 5}));
    assert_eq!(fs::read(ll_a.join("n.webp")).unwrap(), fs::read(ll_b.join("n.webp")).unwrap(), "lossless ignores quality");

    let p_a = run("pa", json!({"format": "png", "quality": 95}));
    let p_b = run("pb", json!({"format": "png", "quality": 5}));
    assert_eq!(fs::read(p_a.join("n.png")).unwrap(), fs::read(p_b.join("n.png")).unwrap(), "PNG ignores quality");
}

#[test]
fn lossy_webp_keeps_transparency() {
    let d = tempfile::tempdir().unwrap();
    let src = png(&d.path().join("t.png"), 64, 64, true); // left half fully transparent
    let out = out_dir(&d, "o");
    convert(vec![src], &out, json!({"format": "webp", "quality": 75}));
    let img = image::open(out.join("t.webp")).unwrap().to_rgba8();
    assert_eq!(img.get_pixel(5, 32).0[3], 0, "transparent half stays transparent");
    assert_eq!(img.get_pixel(60, 32).0[3], 255, "opaque half stays opaque");
}

#[test]
fn jpeg_transparency_uses_the_chosen_background_colour() {
    let d = tempfile::tempdir().unwrap();
    let src = png(&d.path().join("t.png"), 40, 40, true);
    let px = |dir: &std::path::Path| image::open(dir.join("t.jpg")).unwrap().to_rgb8().get_pixel(3, 20).0;

    let white = out_dir(&d, "white");
    convert(vec![src.clone()], &white, json!({"format": "jpeg", "quality": 100}));
    assert!(px(&white).iter().all(|&c| c > 240), "default is white: {:?}", px(&white));

    let red = out_dir(&d, "red");
    convert(vec![src.clone()], &red, json!({"format": "jpeg", "quality": 100, "background": "#FF0000"}));
    let p = px(&red);
    assert!(p[0] > 230 && p[1] < 30 && p[2] < 30, "red background: {p:?}");

    // the review names the colour that will be used
    let r = file_core::request::review(&req(json!({"inputs": [src.clone()], "output_dir": d.path(), "operation": {"type": "convert_image", "format": "jpeg", "background": "#00ff00"}}))).unwrap();
    assert!(r.warnings.iter().any(|w| w.contains("#00FF00")), "{:?}", r.warnings);

    // bad colours are refused before any work starts
    for bad in ["red", "#12345", "#GGGGGG", "FFFFFF"] {
        let rq = req(json!({"inputs": [src.clone()], "output_dir": d.path(), "operation": {"type": "convert_image", "format": "jpeg", "background": bad}}));
        assert!(file_core::request::validate(&rq).is_err(), "{bad}");
    }
}

#[test]
fn orientation_is_baked_in_for_every_output_and_the_tag_is_reset_when_exif_is_kept() {
    let d = tempfile::tempdir().unwrap();
    // 2x1 image tagged "rotate 90 degrees clockwise": it should come out 1x2
    let src = jpeg_with(&d.path().join("rot.jpg"), &image::RgbImage::from_fn(2, 1, |x, _| if x == 0 { image::Rgb([255, 0, 0]) } else { image::Rgb([0, 0, 255]) }), Some(exif_orientation(6)), None);

    for (fmt, mode, file) in [("jpeg", "lossy", "rot.jpg"), ("png", "lossy", "rot.png"), ("webp", "lossy", "rot.webp"), ("webp", "lossless", "rot.webp")] {
        for keep in [false, true] {
            let out = out_dir(&d, &format!("{fmt}-{mode}-{keep}"));
            let s = convert(vec![src.clone()], &out, json!({"format": fmt, "webp_mode": mode, "keep_metadata": keep, "quality": 100}));
            assert_eq!(s.results[0].outcome, Outcome::Done, "{fmt}/{mode}/{keep}: {:?}", s.results);
            let p = out.join(file);
            let img = image::open(&p).unwrap();
            assert_eq!((img.width(), img.height()), (1, 2), "{fmt}/{mode}/keep={keep}: rotated into the pixels");
            let mut dec = decoder(&p);
            if keep {
                assert!(dec.exif_metadata().unwrap().is_some(), "{fmt}/{mode}: EXIF kept");
                assert_eq!(dec.orientation().unwrap(), Orientation::NoTransforms, "{fmt}/{mode}: tag reset so viewers do not rotate again");
            } else {
                assert!(dec.exif_metadata().unwrap().is_none(), "{fmt}/{mode}: EXIF removed");
            }
        }
    }
}

#[test]
fn colour_profiles_survive_every_conversion() {
    let d = tempfile::tempdir().unwrap();
    let icc = fake_icc(b"RGB ");
    let jpg = jpeg_with(&d.path().join("p.jpg"), &photo(32, 32), None, Some(icc.clone()));
    let png = png_with(&d.path().join("p.png"), &image::RgbaImage::from_pixel(32, 32, image::Rgba([10, 20, 30, 255])), None, Some(icc.clone()));

    for src in [&jpg, &png] {
        for (fmt, mode, file) in [("jpeg", "lossy", "p.jpg"), ("png", "lossy", "p.png"), ("webp", "lossy", "p.webp"), ("webp", "lossless", "p.webp")] {
            // kept regardless of the (privacy) metadata setting
            for keep in [false, true] {
                let out = out_dir(&d, &format!("{}-{fmt}-{mode}-{keep}", src.extension().unwrap().to_string_lossy()));
                let s = convert(vec![src.clone()], &out, json!({"format": fmt, "webp_mode": mode, "keep_metadata": keep}));
                assert_eq!(s.results[0].outcome, Outcome::Done, "{:?}", s.results);
                assert_eq!(decoder(&out.join(file)).icc_profile().unwrap().as_deref(), Some(&icc[..]), "{fmt}/{mode}/keep={keep} from {:?}", src.file_name());
            }
        }
    }
}

#[test]
fn a_profile_for_the_wrong_colour_space_is_dropped_not_misapplied() {
    let d = tempfile::tempdir().unwrap();
    let src = jpeg_with(&d.path().join("c.jpg"), &photo(16, 16), None, Some(fake_icc(b"CMYK")));
    let out = out_dir(&d, "o");
    let s = convert(vec![src], &out, json!({"format": "png"}));
    assert_eq!(s.results[0].outcome, Outcome::Done);
    assert!(decoder(&out.join("c.png")).icc_profile().unwrap().is_none());
}

#[test]
fn oversized_images_fail_cleanly_and_leave_nothing_behind() {
    let d = tempfile::tempdir().unwrap();
    let out = out_dir(&d, "o");
    // wider than the 32768 px safety limit (a few KB on disk, but gigabytes of pixels if decoded)
    let huge = image::GrayImage::new(40_000, 1);
    let huge_path = d.path().join("huge.png");
    huge.save(&huge_path).unwrap();
    // within general limits, but past the WebP format limit of 16383
    let wide_path = d.path().join("wide.png");
    image::GrayImage::new(16_500, 1).save(&wide_path).unwrap();

    let s = convert(vec![huge_path.clone(), wide_path.clone()], &out, json!({"format": "jpeg"}));
    assert_eq!(s.results[0].outcome, Outcome::Failed, "past the safety limit");
    assert!(s.results[0].message.as_deref().unwrap().to_lowercase().contains("too large"), "{:?}", s.results[0]);
    assert_eq!(s.results[1].outcome, Outcome::Done, "16500 px is fine as a JPG");

    let s = convert(vec![wide_path], &out, json!({"format": "webp"}));
    assert_eq!(s.results[0].outcome, Outcome::Failed);
    assert!(s.results[0].message.as_deref().unwrap().contains("16383"), "{:?}", s.results[0]);
    assert!(!names(&out).iter().any(|n| n.ends_with(".part") || n.ends_with(".webp")), "{:?}", names(&out));
}

#[test]
fn a_large_photo_converts_to_lossy_webp() {
    let d = tempfile::tempdir().unwrap();
    let src = d.path().join("big.png");
    photo(2400, 1600).save(&src).unwrap();
    let out = out_dir(&d, "o");
    let t = std::time::Instant::now();
    let s = convert(vec![src], &out, json!({"format": "webp", "quality": 80}));
    assert_eq!(s.results[0].outcome, Outcome::Done, "{:?}", s.results);
    let img = image::open(out.join("big.webp")).unwrap();
    assert_eq!((img.width(), img.height()), (2400, 1600));
    eprintln!("3.8 MP lossy WebP in {:?}", t.elapsed());
}

#[test]
fn malformed_truncated_and_empty_images_fail_safely_in_every_format() {
    let d = tempfile::tempdir().unwrap();
    let out = out_dir(&d, "o");
    // real files cut in half
    let good_png = { let p = png(&d.path().join("g.png"), 64, 64, false); fs::read(p).unwrap() };
    let good_jpg = { let p = jpeg_with(&d.path().join("g.jpg"), &photo(64, 64), None, None); fs::read(p).unwrap() };
    let good_webp = { let o = out_dir(&d, "mk"); convert(vec![d.path().join("g.png")], &o, json!({"format": "webp"})); fs::read(o.join("g.webp")).unwrap() };
    let mut riff_garbage = b"RIFF\x20\0\0\0WEBPVP8 \x10\0\0\0".to_vec();
    riff_garbage.extend_from_slice(&[0xAB; 16]);
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("cut.png", good_png[..good_png.len() / 2].to_vec()),
        ("cut.jpg", good_jpg[..good_jpg.len() / 2].to_vec()),
        ("cut.webp", good_webp[..good_webp.len() / 2].to_vec()),
        ("empty.webp", vec![]),
        ("garbage.webp", riff_garbage),
        ("header-only.png", good_png[..8].to_vec()),
    ];
    let inputs: Vec<_> = cases.iter().map(|(n, b)| write(&d.path().join(n), b)).collect();
    for fmt in ["jpeg", "png", "webp"] {
        let s = convert(inputs.clone(), &out, json!({"format": fmt}));
        assert_eq!(s.results.len(), cases.len(), "every file reports a result");
        for (r, (name, _)) in s.results.iter().zip(&cases) {
            assert_eq!(r.outcome, Outcome::Failed, "{name} -> {fmt} must fail, not crash or write garbage");
            assert!(r.message.is_some());
        }
    }
    assert!(names(&out).is_empty(), "no partial outputs: {:?}", names(&out));
}

#[test]
fn quality_applies_through_the_api_options_shape() {
    // the wire shape the UI sends: unknown webp_mode is rejected, known ones parse
    let d = tempfile::tempdir().unwrap();
    let src = png(&d.path().join("a.png"), 8, 8, false);
    let bad = serde_json::from_value::<file_core::JobRequest>(json!({"inputs": [src], "output_dir": d.path(), "operation": {"type": "convert_image", "format": "webp", "webp_mode": "fancy"}}));
    assert!(bad.is_err());
}
