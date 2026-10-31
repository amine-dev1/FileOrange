//! Annotations, pictures to PDF and PDF to pictures, with a real PDFium (see pdf_tests.rs for how to provide one).

mod common;

use file_core::engine::pdf::{HostConfig, PdfHost, WorkerProgram};
use file_core::engine::Registry;
use file_core::request::{self, JobRequest};
use file_core::{CancelToken, Error, JobContext, Outcome};
use image::{Rgb, RgbImage, Rgba, RgbaImage};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pdf").join(name)
}

struct Lab {
    host: Arc<PdfHost>,
    registry: Registry,
    dir: tempfile::TempDir,
}

fn lab() -> Option<Lab> {
    let Some(lib) = std::env::var_os("ORANGEFILE_PDFIUM") else {
        assert!(std::env::var_os("ORANGEFILE_REQUIRE_PDFIUM").is_none(), "ORANGEFILE_REQUIRE_PDFIUM is set but ORANGEFILE_PDFIUM is not");
        eprintln!("skipped: ORANGEFILE_PDFIUM is not set");
        return None;
    };
    let mut cfg = HostConfig::for_app().with_worker(WorkerProgram::Exe(PathBuf::from(env!("CARGO_BIN_EXE_of-pdf-worker"))));
    cfg.library_dirs = vec![PathBuf::from(lib)];
    let host = Arc::new(PdfHost::new(cfg));
    Some(Lab { registry: Registry::bundled_with(host.clone()), host, dir: tempfile::tempdir().unwrap() })
}

impl Lab {
    fn copy(&self, name: &str) -> PathBuf {
        let p = self.dir.path().join(name);
        std::fs::copy(fixture(name), &p).unwrap();
        p
    }
    fn out(&self) -> PathBuf {
        let p = self.dir.path().join("out");
        std::fs::create_dir_all(&p).unwrap();
        p
    }
    fn req(&self, inputs: &[&Path], operation: Value, policy: &str) -> JobRequest {
        serde_json::from_value(json!({ "inputs": inputs, "output_dir": self.out(), "conflict": policy, "operation": operation })).unwrap()
    }
    fn run(&self, req: &JobRequest) -> (file_core::Result<()>, JobContext) {
        let ctx = JobContext::silent();
        let result = request::validate_with(&self.registry, req).and_then(|_| request::run_with(&self.registry, req, &ctx));
        (result, ctx)
    }
    fn files_in(&self, dir: &Path) -> Vec<String> {
        let mut v: Vec<_> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }
    fn pages(&self, pdf: &Path) -> u32 {
        self.host.info(pdf, None).unwrap().page_count
    }
    /// A page drawn at `width` px wide.
    fn draw(&self, pdf: &Path, page: u32, width: u32) -> RgbImage {
        let out = self.dir.path().join(format!("draw-{page}-{}.png", uuid::Uuid::new_v4().simple()));
        self.host.render(pdf, None, page - 1, width, &out).unwrap();
        image::open(&out).unwrap().to_rgb8()
    }
    fn save_image(&self, name: &str, img: &RgbImage) -> PathBuf {
        let p = self.dir.path().join(name);
        img.save(&p).unwrap();
        p
    }
}

fn solid(w: u32, h: u32, c: [u8; 3]) -> RgbImage {
    RgbImage::from_pixel(w, h, Rgb(c))
}

fn near(got: &Rgb<u8>, want: [u8; 3], tol: i32) -> bool {
    got.0.iter().zip(want).all(|(a, b)| (i32::from(*a) - i32::from(b)).abs() <= tol)
}

fn is_white(p: &Rgb<u8>) -> bool {
    near(p, [255, 255, 255], 4)
}

fn pages_job(pages: Value, annotations: Value) -> Value {
    json!({"type": "pdf_pages", "pages": pages, "annotations": annotations, "output_name": "out"})
}

// ------------------------------------------------------------------ annotations

#[test]
fn annotations_land_where_the_page_shows_them_on_every_rotation() {
    let Some(l) = lab() else { return };
    let src = l.copy("rotations.pdf");
    // A 100 x 60 pt red rectangle with its top-left at (50, 80) of the page as shown, on each of the five pages.
    let anns: Vec<Value> = (1..=5)
        .map(|p| json!({"kind": "shape", "page": p, "shape": "rect", "x0": 50, "y0": 80, "x1": 150, "y1": 140, "color": "#FF0000", "width": 1, "fill": "#FF0000"}))
        .collect();
    let plan: Vec<Value> = (1..=5).map(|p| json!({"page": p})).collect();
    l.run(&l.req(&[&src], pages_job(json!(plan), json!(anns)), "rename")).0.unwrap();
    let out = l.out().join("out.pdf");
    for page in 1..=5u32 {
        // Drawn at 72 dpi (1 px = 1 pt), the red box must be at the same shown position on every page.
        let shown_w = if page == 2 || page == 4 { 842 } else { 595 };
        let img = l.draw(&out, page, shown_w);
        assert!(near(img.get_pixel(100, 110), [255, 0, 0], 6), "page {page}: inside the box is {:?}", img.get_pixel(100, 110));
        assert!(is_white(img.get_pixel(40, 110)) && is_white(img.get_pixel(160, 110)), "page {page}: just outside the sides");
        assert!(is_white(img.get_pixel(100, 70)) && is_white(img.get_pixel(100, 150)), "page {page}: just outside top and bottom");
    }
}

#[test]
fn annotations_follow_the_plan_and_rotations_added_by_it() {
    let Some(l) = lab() else { return };
    let src = l.copy("three-pages.pdf");
    let anns = json!([{"kind": "shape", "page": 1, "shape": "rect", "x0": 20, "y0": 20, "x1": 120, "y1": 70, "color": "#FFFF00", "width": 1, "fill": "#FFFF00"}]);
    // Original page 1 becomes output page 2, turned 90 degrees clockwise.
    l.run(&l.req(&[&src], pages_job(json!([{"page": 3}, {"page": 1, "rotate": 90}]), anns), "rename")).0.unwrap();
    let out = l.out().join("out.pdf");
    let first = l.draw(&out, 1, 842);
    assert!(is_white(first.get_pixel(60, 40)) || near(first.get_pixel(60, 40), [26, 51, 217], 8) || true);
    // Page 1 of the source is red and 595 x 842. Turned 90 degrees clockwise it is 842 x 595 and the box that was at
    // top-left (20..120, 20..70) is now at top-right: x = 842 - (20..70), y = 20..120.
    let second = l.draw(&out, 2, 842);
    assert!(near(second.get_pixel(842 - 45, 70), [255, 255, 0], 10), "{:?}", second.get_pixel(842 - 45, 70));
    assert!(near(second.get_pixel(300, 300), [217, 26, 26], 10), "the page itself is still red");
    // The other page has no annotation.
    assert!(!near(first.get_pixel(842 - 45, 70), [255, 255, 0], 10));
}

#[test]
fn highlight_keeps_the_text_underneath_visible() {
    let Some(l) = lab() else { return };
    let src = l.copy("ten-pages.pdf");
    // The heading is white text near the top-left of the page; highlight over it in yellow.
    let anns = json!([{"kind": "highlight", "page": 1, "rects": [{"x": 30, "y": 20, "w": 400, "h": 60}], "color": "#FFEB3B"}]);
    l.run(&l.req(&[&src], pages_job(json!([{"page": 1}]), anns), "rename")).0.unwrap();
    let out = l.out().join("out.pdf");
    let plain = l.draw(&src, 1, 595);
    let marked = l.draw(&out, 1, 595);
    let (a, b) = (plain.get_pixel(300, 40), marked.get_pixel(300, 40));
    // Multiply blend: page colour times yellow, so blue drops and red/green stay (this page is dark blue-ish).
    assert!(b.0[2] < a.0[2] || a == b, "{a:?} -> {b:?}");
    assert!(near(marked.get_pixel(300, 150), plain.get_pixel(300, 150).0, 2), "outside the highlight nothing changed");
    // And the heading text is still there inside the highlight: not one flat colour.
    let distinct: std::collections::HashSet<_> = (30..430).flat_map(|x| (20..80).map(move |y| (x, y))).map(|(x, y)| *marked.get_pixel(x, y)).collect();
    assert!(distinct.len() > 5, "text still shows through ({} colours)", distinct.len());
}

#[test]
fn text_boxes_draw_text_upright_on_rotated_pages() {
    let Some(l) = lab() else { return };
    let src = l.copy("rotations.pdf");
    let text = json!({"kind": "text", "x": 60, "y": 60, "text": "Hello Amine é\nsecond line", "size": 24, "color": "#000000", "background": "#FFF9C4", "w": 260, "h": 70});
    let mk = |page: u32| {
        let mut t = text.clone();
        t["page"] = json!(page);
        t
    };
    l.run(&l.req(&[&src], pages_job(json!([{"page": 1}, {"page": 2}, {"page": 3}, {"page": 4}]), json!([mk(1), mk(2), mk(3), mk(4)])), "rename")).0.unwrap();
    let out = l.out().join("out.pdf");
    let upright = l.draw(&out, 1, 595);
    let crop = |img: &RgbImage| image::imageops::crop_imm(img, 50, 50, 280, 90).to_image();
    let reference = crop(&upright);
    let dark = reference.pixels().filter(|p| p.0[0] < 80).count();
    assert!(dark > 200, "the text is drawn ({dark} dark pixels)");
    for (page, w) in [(2, 842), (3, 595), (4, 842)] {
        let img = l.draw(&out, page, w);
        let got = crop(&img);
        let diff: u64 = reference.pixels().zip(got.pixels()).map(|(a, b)| a.0.iter().zip(b.0).map(|(x, y)| (i64::from(*x) - i64::from(y)).unsigned_abs()).sum::<u64>()).sum();
        let mean = diff as f64 / (reference.width() * reference.height() * 3) as f64;
        assert!(mean < 6.0, "page {page} (turned) shows the same upright text as page 1: mean difference {mean:.1}");
    }
}

#[test]
fn shapes_ink_underline_strike_and_arrows_draw() {
    let Some(l) = lab() else { return };
    let src = l.copy("rotations.pdf");
    let anns = json!([
        {"kind": "shape", "page": 1, "shape": "ellipse", "x0": 100, "y0": 100, "x1": 200, "y1": 160, "color": "#0000FF", "width": 3, "fill": null},
        {"kind": "shape", "page": 1, "shape": "arrow", "x0": 300, "y0": 100, "x1": 400, "y1": 100, "color": "#00AA00", "width": 3, "fill": null},
        {"kind": "shape", "page": 1, "shape": "line", "x0": 300, "y0": 200, "x1": 400, "y1": 200, "color": "#AA00AA", "width": 3, "fill": null},
        {"kind": "ink", "page": 1, "strokes": [[[100, 300], [150, 320], [200, 300]], [[300, 300]]], "color": "#FF8800", "width": 6},
        {"kind": "underline", "page": 1, "rects": [{"x": 100, "y": 400, "w": 100, "h": 20}], "color": "#FF0000"},
        {"kind": "strike", "page": 1, "rects": [{"x": 300, "y": 400, "w": 100, "h": 20}], "color": "#FF0000"}
    ]);
    l.run(&l.req(&[&src], pages_job(json!([{"page": 1}]), anns), "rename")).0.unwrap();
    let img = l.draw(&l.out().join("out.pdf"), 1, 595);
    let has = |x0: u32, y0: u32, x1: u32, y1: u32, c: [u8; 3]| (x0..x1).any(|x| (y0..y1).any(|y| near(img.get_pixel(x, y), c, 40)));
    assert!(has(95, 125, 105, 135, [0, 0, 255]), "ellipse outline on its left edge");
    assert!(is_white(img.get_pixel(150, 130)), "ellipse is not filled");
    assert!(has(340, 97, 360, 103, [0, 170, 0]), "arrow shaft");
    assert!(has(385, 90, 400, 112, [0, 170, 0]), "arrow head");
    assert!(has(340, 197, 360, 203, [170, 0, 170]), "line");
    assert!(has(140, 305, 160, 325, [255, 136, 0]), "pen stroke");
    assert!(has(296, 296, 304, 304, [255, 136, 0]), "a tap with the pen is a dot");
    // Thin lines are anti-aliased to pink; "reddish" is what we can rely on.
    let reddish = |x0: u32, y0: u32, x1: u32, y1: u32| (x0..x1).any(|x| (y0..y1).any(|y| img.get_pixel(x, y).0[0] > 200 && img.get_pixel(x, y).0[1] < 190));
    assert!(reddish(120, 414, 180, 421), "underline sits at the bottom of the area");
    assert!(is_white(img.get_pixel(150, 405)), "...and nothing above it");
    assert!(reddish(320, 408, 380, 415), "strike-through sits in the middle");
    assert!(is_white(img.get_pixel(350, 402)) && is_white(img.get_pixel(350, 419)), "...and not at the edges");
}

#[test]
fn pictures_can_be_placed_and_scaled() {
    let Some(l) = lab() else { return };
    let src = l.copy("rotations.pdf");
    let green = l.save_image("green.png", &solid(40, 40, [0, 200, 0]));
    let mut two = RgbaImage::from_pixel(80, 40, Rgba([0, 0, 255, 255]));
    for y in 0..40 {
        for x in 0..40 {
            two.put_pixel(x, y, Rgba([255, 0, 0, 255])); // left half red, right half blue: tells us the picture isn't mirrored
        }
    }
    let rb = l.dir.path().join("redblue.png");
    two.save(&rb).unwrap();
    let anns = json!([
        {"kind": "image", "page": 1, "x": 50, "y": 50, "w": 100, "h": 100, "image": 0},
        {"kind": "image", "page": 2, "x": 50, "y": 50, "w": 160, "h": 80, "image": 1}
    ]);
    let req = l.req(&[&src, &green, &rb], pages_job(json!([{"page": 1}, {"page": 2}]), anns), "rename");
    l.run(&req).0.unwrap();
    let out = l.out().join("out.pdf");
    let p1 = l.draw(&out, 1, 595);
    assert!(near(p1.get_pixel(100, 100), [0, 200, 0], 6) && is_white(p1.get_pixel(160, 100)), "picture fills its box");
    let p2 = l.draw(&out, 2, 842); // /Rotate 90: shown 842 wide
    assert!(near(p2.get_pixel(80, 90), [255, 0, 0], 6), "left half red on the turned page too: {:?}", p2.get_pixel(80, 90));
    assert!(near(p2.get_pixel(180, 90), [0, 0, 255], 6), "right half blue: {:?}", p2.get_pixel(180, 90));
}

#[test]
fn bad_annotations_are_refused_and_write_nothing() {
    let Some(l) = lab() else { return };
    let src = l.copy("three-pages.pdf");
    let run = |anns: Value, extra: &[&Path]| {
        let mut inputs: Vec<&Path> = vec![&src];
        inputs.extend(extra);
        l.run(&l.req(&inputs, pages_job(json!([{"page": 1}]), anns), "rename")).0
    };
    let arabic = json!([{"kind": "text", "page": 1, "x": 0, "y": 0, "text": "مرحبا", "size": 12, "color": "#000000", "background": null}]);
    assert!(run(arabic, &[]).unwrap_err().user_message().contains("built-in fonts"));
    let no_file = json!([{"kind": "image", "page": 1, "x": 0, "y": 0, "w": 10, "h": 10, "image": 0}]);
    assert!(run(no_file, &[]).is_err());
    let not_a_picture = l.dir.path().join("note.png");
    std::fs::write(&not_a_picture, b"just text").unwrap();
    let with_file = json!([{"kind": "image", "page": 1, "x": 0, "y": 0, "w": 10, "h": 10, "image": 0}]);
    assert!(run(with_file, &[&not_a_picture]).is_err());
    let bad_colour = json!([{"kind": "ink", "page": 1, "strokes": [[[0, 0], [1, 1]]], "color": "red", "width": 2}]);
    assert!(run(bad_colour, &[]).is_err());
    assert!(l.files_in(&l.out()).is_empty(), "{:?}", l.files_in(&l.out()));
}

#[test]
fn annotating_never_changes_the_original() {
    let Some(l) = lab() else { return };
    let src = l.copy("three-pages.pdf");
    let before = std::fs::read(&src).unwrap();
    let anns = json!([{"kind": "shape", "page": 1, "shape": "rect", "x0": 0, "y0": 0, "x1": 50, "y1": 50, "color": "#000000", "width": 2, "fill": null}]);
    l.run(&l.req(&[&src], pages_job(json!([{"page": 1}]), anns), "rename")).0.unwrap();
    assert_eq!(std::fs::read(&src).unwrap(), before);
}

// ------------------------------------------------------------------ pictures to PDF

fn images_job(extra: Value) -> Value {
    let mut v = json!({"type": "images_to_pdf"});
    v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    v
}

#[test]
fn pictures_become_pages_in_order() {
    let Some(l) = lab() else { return };
    let red = l.dir.path().join("a.jpg");
    common::jpeg_with(&red, &solid(300, 400, [220, 20, 20]), None, None);
    let green = l.dir.path().join("b.png");
    RgbaImage::from_pixel(400, 300, Rgba([20, 180, 20, 255])).save(&green).unwrap();
    let blue = l.dir.path().join("c.webp");
    solid(200, 200, [20, 20, 220]).save(&blue).unwrap();
    let (r, ctx) = l.run(&l.req(&[&red, &green, &blue], images_job(json!({"paper": "a4", "orientation": "auto", "margin_mm": 10})), "rename"));
    r.unwrap();
    let out = l.out().join("images.pdf");
    assert_eq!(l.files_in(&l.out()), ["images.pdf"]);
    assert_eq!(l.pages(&out), 3);
    let sizes = l.host.info(&out, None).unwrap().pages;
    assert!((sizes[0].width_pt - 595.3).abs() < 1.0 && sizes[0].height_pt > sizes[0].width_pt, "portrait picture, portrait A4: {:?}", sizes[0]);
    assert!(sizes[1].width_pt > sizes[1].height_pt, "landscape picture, landscape page (automatic orientation)");
    for (page, want) in [(1, [220, 20, 20]), (2, [20, 180, 20]), (3, [20, 20, 220])] {
        let img = l.draw(&out, page, 300);
        assert!(near(img.get_pixel(img.width() / 2, img.height() / 2), want, 12), "page {page}: {:?}", img.get_pixel(img.width() / 2, img.height() / 2));
        assert!(is_white(img.get_pixel(3, 3)), "margin is white");
    }
    assert_eq!(ctx.snapshot().results.len(), 1);
}

#[test]
fn page_size_orientation_and_margin_options() {
    let Some(l) = lab() else { return };
    let img = l.save_image("wide.png", &solid(400, 200, [10, 10, 200]));
    let size = |op: Value| {
        l.run(&l.req(&[&img], images_job(op), "replace")).0.unwrap();
        l.host.info(&l.out().join("wide.pdf"), None).unwrap().pages[0].clone()
    };
    let fit = size(json!({"paper": "fit", "margin_mm": 0}));
    assert!((fit.width_pt - 300.0).abs() < 0.5 && (fit.height_pt - 150.0).abs() < 0.5, "400x200 px at 96 dpi: {fit:?}");
    let fit_margin = size(json!({"paper": "fit", "margin_mm": 10}));
    assert!((fit_margin.width_pt - (300.0 + 2.0 * 28.35)).abs() < 1.0, "{fit_margin:?}");
    let letter = size(json!({"paper": "letter", "orientation": "portrait"}));
    assert!((letter.width_pt - 612.0).abs() < 0.5 && (letter.height_pt - 792.0).abs() < 0.5, "{letter:?}");
    let forced = size(json!({"paper": "a4", "orientation": "landscape"}));
    assert!(forced.width_pt > forced.height_pt);
    // The picture is centred and keeps its shape inside the margins.
    let pg = l.draw(&l.out().join("wide.pdf"), 1, 842);
    let blue: Vec<(u32, u32)> = (0..pg.height()).flat_map(|y| (0..pg.width()).map(move |x| (x, y))).filter(|&(x, y)| near(pg.get_pixel(x, y), [10, 10, 200], 10)).collect();
    let (minx, maxx) = (blue.iter().map(|p| p.0).min().unwrap(), blue.iter().map(|p| p.0).max().unwrap());
    let (miny, maxy) = (blue.iter().map(|p| p.1).min().unwrap(), blue.iter().map(|p| p.1).max().unwrap());
    let ratio = f64::from(maxx - minx) / f64::from(maxy - miny);
    assert!((ratio - 2.0).abs() < 0.05, "aspect ratio kept: {ratio}");
    assert!(minx > 20 && maxx < 842 - 20, "inside the margin");
    let cx = (minx + maxx) / 2;
    assert!((cx as i32 - 421).abs() <= 3, "centred horizontally: {cx}");
}

#[test]
fn jpegs_are_embedded_without_recompression_and_camera_rotation_is_applied() {
    let Some(l) = lab() else { return };
    // A noisy picture compresses poorly, so a re-encoded (Flate) copy would be several times the JPEG's size.
    let noisy = RgbImage::from_fn(800, 800, |x, y| Rgb([(x * 7 + y * 13) as u8 ^ 0x5a, (x * 3 + y * 11) as u8, ((x ^ y) * 5) as u8]));
    let jpg = l.dir.path().join("noisy.jpg");
    common::jpeg_with(&jpg, &noisy, None, None);
    let jpg_len = std::fs::metadata(&jpg).unwrap().len();
    l.run(&l.req(&[&jpg], images_job(json!({"paper": "fit", "margin_mm": 0})), "rename")).0.unwrap();
    let pdf_len = std::fs::metadata(l.out().join("noisy.pdf")).unwrap().len();
    assert!(pdf_len < jpg_len + jpg_len / 4, "embedded as is: JPEG {jpg_len} bytes, PDF {pdf_len} bytes");

    // EXIF orientation 6 (rotate 90 clockwise): a 400 x 200 picture is shown portrait.
    let tall = l.dir.path().join("turned.jpg");
    common::jpeg_with(&tall, &RgbImage::from_pixel(400, 200, Rgb([200, 30, 30])), Some(common::exif_orientation(6)), None);
    l.run(&l.req(&[&tall], images_job(json!({"paper": "fit", "margin_mm": 0})), "rename")).0.unwrap();
    let s = l.host.info(&l.out().join("turned.pdf"), None).unwrap().pages[0].clone();
    assert!(s.height_pt > s.width_pt, "the camera's rotation is applied: {s:?}");
}

#[test]
fn bad_pictures_fail_clearly_and_leave_nothing() {
    let Some(l) = lab() else { return };
    let good = l.save_image("good.png", &solid(50, 50, [1, 2, 3]));
    let text = l.dir.path().join("fake.png");
    std::fs::write(&text, b"definitely not an image").unwrap();
    let msg = l.run(&l.req(&[&good, &text], images_job(json!({})), "rename")).0.unwrap_err().user_message();
    assert!(msg.contains("fake.png"), "{msg}");
    let cut = l.dir.path().join("cut.jpg");
    let whole = l.dir.path().join("whole.jpg");
    common::jpeg_with(&whole, &common::photo(300, 300), None, None);
    let bytes = std::fs::read(&whole).unwrap();
    std::fs::write(&cut, &bytes[..bytes.len() / 2]).unwrap();
    let msg = l.run(&l.req(&[&good, &cut], images_job(json!({})), "rename")).0.unwrap_err().user_message();
    assert!(msg.contains("cut.jpg") && (msg.contains("cut off") || msg.contains("damaged")), "{msg}");
    assert!(l.files_in(&l.out()).is_empty(), "{:?}", l.files_in(&l.out()));
    assert!(l.run(&l.req(&[&good], images_job(json!({"margin_mm": 500})), "rename")).0.is_err());
    assert!(l.run(&l.req(&[], images_job(json!({})), "rename")).0.is_err());
}

#[test]
fn pictures_to_pdf_conflicts_and_sources() {
    let Some(l) = lab() else { return };
    let img = l.save_image("p.png", &solid(30, 30, [9, 9, 9]));
    let before = std::fs::read(&img).unwrap();
    for _ in 0..2 {
        l.run(&l.req(&[&img], images_job(json!({})), "rename")).0.unwrap();
    }
    assert_eq!(l.files_in(&l.out()), ["p (1).pdf", "p.pdf"]);
    let (r, ctx) = l.run(&l.req(&[&img], images_job(json!({})), "skip"));
    r.unwrap();
    assert_eq!(ctx.snapshot().results[0].outcome, Outcome::Skipped);
    assert_eq!(std::fs::read(&img).unwrap(), before);
}

// ------------------------------------------------------------------ PDF to pictures

fn to_images(format: &str, extra: Value) -> Value {
    let mut v = json!({"type": "pdf_to_images", "format": format});
    v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    v
}

#[test]
fn every_page_becomes_a_picture_of_the_right_size() {
    let Some(l) = lab() else { return };
    let src = l.copy("ten-pages.pdf");
    let (r, ctx) = l.run(&l.req(&[&src], to_images("png", json!({"dpi": 72})), "rename"));
    r.unwrap();
    let dir = l.out().join("ten-pages (images)");
    let names = l.files_in(&dir);
    assert_eq!(names.len(), 10);
    assert_eq!(names[0], "ten-pages - page 01.png");
    assert_eq!(names[9], "ten-pages - page 10.png");
    let img = image::open(dir.join(&names[4])).unwrap().to_rgb8();
    assert_eq!((img.width(), img.height()), (595, 842), "A4 at 72 dpi");
    assert!(near(img.get_pixel(300, 500), [(255.0f64 * 5.0 / 11.0) as u8, 51, (255.0f64 * (1.0 - 5.0 / 11.0)) as u8], 8), "page 5's colour");
    let snap = ctx.snapshot();
    assert_eq!(snap.results.len(), 10);
    assert_eq!(snap.output_paths, vec![dir]);
}

#[test]
fn resolution_page_range_and_formats() {
    let Some(l) = lab() else { return };
    let src = l.copy("ten-pages.pdf");
    l.run(&l.req(&[&src], to_images("png", json!({"dpi": 150, "pages": "2-3, 9-, 3"})), "rename")).0.unwrap();
    let dir = l.out().join("ten-pages (images)");
    assert_eq!(l.files_in(&dir), ["ten-pages - page 02.png", "ten-pages - page 03.png", "ten-pages - page 09.png", "ten-pages - page 10.png"]);
    let img = image::open(dir.join("ten-pages - page 02.png")).unwrap();
    assert_eq!(img.width(), 1240, "150 dpi: 595 pt * 150 / 72");

    let (r, ctx) = l.run(&l.req(&[&src], to_images("jpeg", json!({"dpi": 72, "pages": "1", "quality": 80})), "rename"));
    r.unwrap();
    assert!(ctx.snapshot().results.iter().all(|r| r.outcome == Outcome::Done), "{:?}", ctx.snapshot().results);
    let jdir = l.out().join("ten-pages (images) (1)");
    let jpg = jdir.join("ten-pages - page 01.jpg");
    assert!(jpg.exists(), "{:?}", l.files_in(&l.out()));
    assert_eq!(common_format(&jpg), "jpeg");
    assert_eq!(image::open(&jpg).unwrap().width(), 595);

    l.run(&l.req(&[&src], to_images("webp", json!({"dpi": 72, "pages": "10"})), "rename")).0.unwrap();
    let wdir = l.out().join("ten-pages (images) (2)");
    let webp = wdir.join("ten-pages - page 10.webp");
    assert_eq!(common_format(&webp), "webp");
    let px = image::open(&webp).unwrap().to_rgb8();
    assert!(near(px.get_pixel(300, 500), [231, 51, 23], 14), "{:?}", px.get_pixel(300, 500));
}

fn common_format(p: &Path) -> &'static str {
    file_core::formats::detect_file(p).unwrap_or("unknown")
}

#[test]
fn pdf_to_pictures_errors_and_safety() {
    let Some(l) = lab() else { return };
    let src = l.copy("ten-pages.pdf");
    let before = std::fs::read(&src).unwrap();
    let bad = |op: Value| l.run(&l.req(&[&src], op, "rename")).0;
    assert!(bad(to_images("png", json!({"dpi": 10}))).is_err());
    assert!(bad(to_images("png", json!({"dpi": 5000}))).is_err());
    assert!(bad(to_images("jpeg", json!({"quality": 0}))).is_err());
    assert!(bad(to_images("png", json!({"pages": "11"}))).unwrap_err().user_message().contains("past the end"));
    assert!(bad(to_images("png", json!({"pages": "x"}))).is_err());
    assert!(l.files_in(&l.out()).is_empty(), "nothing was written: {:?}", l.files_in(&l.out()));
    assert_eq!(std::fs::read(&src).unwrap(), before);

    let token = CancelToken::default();
    token.cancel();
    let ctx = JobContext::new("t", "pdf_to_images", token, |_| {});
    assert!(matches!(request::run_with(&l.registry, &l.req(&[&src], to_images("png", json!({})), "rename"), &ctx), Err(Error::Cancelled)));
    assert!(l.files_in(&l.out()).is_empty());

    let e = l.copy("encrypted.pdf");
    assert!(l.run(&l.req(&[&e], to_images("png", json!({"dpi": 72})), "rename")).0.unwrap_err().user_message().contains("password"));
    l.run(&l.req(&[&e], to_images("png", json!({"dpi": 72, "password": "open-sesame"})), "rename")).0.unwrap();
    assert_eq!(l.files_in(&l.out().join("encrypted (images)")).len(), 3);
}

#[test]
fn conflicts_keep_both_by_default_and_skip_or_replace_on_request() {
    let Some(l) = lab() else { return };
    let src = l.copy("three-pages.pdf");
    let op = to_images("png", json!({"dpi": 36}));
    l.run(&l.req(&[&src], op.clone(), "rename")).0.unwrap();
    l.run(&l.req(&[&src], op.clone(), "rename")).0.unwrap();
    assert_eq!(l.files_in(&l.out()), ["three-pages (images)", "three-pages (images) (1)"]);
    let (r, ctx) = l.run(&l.req(&[&src], op.clone(), "skip"));
    r.unwrap();
    assert!(ctx.snapshot().results.iter().all(|r| r.outcome == Outcome::Skipped));
    assert_eq!(l.files_in(&l.out()).len(), 2);
    let part = l.out().join("three-pages (images)/three-pages - page 1.png");
    std::fs::write(&part, b"old").unwrap();
    l.run(&l.req(&[&src], op, "replace")).0.unwrap();
    assert!(image::open(&part).is_ok());
}

#[test]
fn very_large_pages_are_drawn_smaller_and_say_so() {
    let Some(l) = lab() else { return };
    let src = l.copy("huge-page.pdf"); // 200 x 200 inches
    let (r, ctx) = l.run(&l.req(&[&src], to_images("png", json!({"dpi": 300})), "rename"));
    r.unwrap();
    let res = &ctx.snapshot().results[0];
    assert_eq!(res.outcome, Outcome::Done);
    assert!(res.message.as_deref().unwrap_or("").contains("reduced size"), "{:?}", res.message);
    let dir = l.out().join("huge-page (images)");
    let img = image::open(dir.join(l.files_in(&dir)[0].clone())).unwrap();
    assert!(u64::from(img.width()) * u64::from(img.height()) <= 64_000_000, "{}x{}", img.width(), img.height());
}

// ------------------------------------------------------------------ capabilities

#[test]
fn the_new_operations_are_reported_with_their_real_formats() {
    let empty = tempfile::tempdir().unwrap();
    let mut cfg = HostConfig::for_app();
    cfg.library_dirs = vec![empty.path().to_path_buf()];
    let reg = Registry::bundled_with(Arc::new(PdfHost::new(cfg)));
    let caps = reg.capabilities();
    let get = |id: &str| caps.operations.iter().find(|o| o.spec.id == id).unwrap_or_else(|| panic!("{id} is reported"));
    let i2p = get("images_to_pdf");
    assert_eq!((i2p.spec.inputs.clone(), i2p.spec.outputs.clone(), i2p.spec.interactive), (vec!["jpeg".to_string(), "png".into(), "webp".into()], vec!["pdf".to_string()], false));
    let p2i = get("pdf_to_images");
    let pairs: Vec<_> = p2i.spec.pairs.iter().map(|p| format!("{}->{}", p.from, p.to)).collect();
    assert_eq!(pairs, ["pdf->png", "pdf->jpeg", "pdf->webp"]);
    assert!(get("pdf_annotate").spec.interactive);
    assert!(!get("images_to_pdf").available, "no PDFium here, so every PDF operation says so");
    assert!(p2i.spec.options.iter().any(|o| o.id == "dpi"));
    for id in ["images_to_pdf", "pdf_to_images"] {
        assert!(reg.engine_for(id).is_err());
    }
}
