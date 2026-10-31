//! Draws annotations into a PDF page with PDFium. Runs only inside the worker process.
//!
//! The editor gives positions in the page *as shown* (origin top-left, y down). PDF page objects live in the
//! page's own unrotated space, so every point goes through [`Frame::map`], which undoes the page's /Rotate.
//! Text and pictures need a whole matrix instead of one point; [`Frame::axes`] gives the directions "right" and
//! "up" as the page shows them, expressed in page space.

use super::annotate::{parse_colour, Annotation, ShapeKind};
use image::DynamicImage;
use pdfium_render::prelude::*;

pub type Res<T> = Result<T, String>;

fn e(what: &str) -> impl Fn(PdfiumError) -> String + '_ {
    move |err| format!("{what}: {err}")
}

pub struct Frame {
    x0: f32,
    y0: f32,
    /// Size of the page in its own (unrotated) space.
    w: f32,
    h: f32,
    /// The page's own rotation in degrees clockwise: 0, 90, 180 or 270.
    rot: u16,
}

impl Frame {
    pub fn of(page: &PdfPage) -> Res<Frame> {
        let b = page.boundaries().bounding().map_err(e("page size"))?.bounds;
        let rot = match page.rotation().map_err(e("page rotation"))? {
            PdfPageRenderRotation::None => 0,
            PdfPageRenderRotation::Degrees90 => 90,
            PdfPageRenderRotation::Degrees180 => 180,
            PdfPageRenderRotation::Degrees270 => 270,
        };
        Ok(Frame { x0: b.left().value, y0: b.bottom().value, w: b.width().value, h: b.height().value, rot })
    }

    /// A point of the page as shown (dx right, dy down from the top-left) to page space.
    pub fn map(&self, dx: f32, dy: f32) -> (f32, f32) {
        let (px, py) = match self.rot {
            90 => (dy, dx),
            180 => (self.w - dx, dy),
            270 => (self.w - dy, self.h - dx),
            _ => (dx, self.h - dy),
        };
        (self.x0 + px, self.y0 + py)
    }

    /// Where "right" and "up" on the shown page point, in page space.
    pub fn axes(&self) -> ((f32, f32), (f32, f32)) {
        match self.rot {
            90 => ((0.0, 1.0), (-1.0, 0.0)),
            180 => ((-1.0, 0.0), (0.0, -1.0)),
            270 => ((0.0, -1.0), (1.0, 0.0)),
            _ => ((1.0, 0.0), (0.0, 1.0)),
        }
    }

}

fn colour(s: &str) -> PdfColor {
    let [r, g, b] = parse_colour(s).unwrap_or([0, 0, 0]);
    PdfColor::new(r, g, b, 255)
}

fn pt(v: f32) -> PdfPoints {
    PdfPoints::new(v)
}

struct Style {
    stroke: Option<(PdfColor, f32)>,
    fill: Option<PdfColor>,
    multiply: bool,
}

/// A path through shown-page points. `closed` closes it.
fn path<'a>(page: &mut PdfPage<'a>, doc: &PdfDocument<'a>, f: &Frame, pts: &[(f32, f32)], closed: bool, st: Style) -> Res<()> {
    let Some(&(sx, sy)) = pts.first() else { return Ok(()) };
    let (x, y) = f.map(sx, sy);
    let mut obj = PdfPagePathObject::new(doc, pt(x), pt(y), st.stroke.map(|s| s.0), st.stroke.map(|s| pt(s.1)), st.fill).map_err(e("path"))?;
    for &(px, py) in &pts[1..] {
        let (x, y) = f.map(px, py);
        obj.line_to(pt(x), pt(y)).map_err(e("path"))?;
    }
    if closed {
        obj.close_path().map_err(e("path"))?;
    }
    let mut placed = page.objects_mut().add_path_object(obj).map_err(e("path"))?;
    let _ = placed.set_line_cap(PdfPageObjectLineCap::Round);
    let _ = placed.set_line_join(PdfPageObjectLineJoin::Round);
    if st.multiply {
        let _ = placed.set_blend_mode(PdfPageObjectBlendMode::Multiply);
    }
    Ok(())
}

fn rect_pts(x: f32, y: f32, w: f32, h: f32) -> [(f32, f32); 4] {
    [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
}

fn stroke(c: &str, w: f32) -> Option<(PdfColor, f32)> {
    Some((colour(c), w))
}

pub fn apply<'a>(page: &mut PdfPage<'a>, doc: &PdfDocument<'a>, font: PdfFontToken, a: &Annotation, images: &[DynamicImage]) -> Res<()> {
    let f = Frame::of(page)?;
    match a {
        Annotation::Highlight { rects, color, .. } => {
            for r in rects {
                path(page, doc, &f, &rect_pts(r.x, r.y, r.w, r.h), true, Style { stroke: None, fill: Some(colour(color)), multiply: true })?;
            }
        }
        Annotation::Underline { rects, color, .. } => {
            for r in rects {
                let y = r.y + r.h - r.h * 0.04;
                path(page, doc, &f, &[(r.x, y), (r.x + r.w, y)], false, Style { stroke: stroke(color, (r.h * 0.07).max(0.8)), fill: None, multiply: false })?;
            }
        }
        Annotation::Strike { rects, color, .. } => {
            for r in rects {
                let y = r.y + r.h * 0.55;
                path(page, doc, &f, &[(r.x, y), (r.x + r.w, y)], false, Style { stroke: stroke(color, (r.h * 0.07).max(0.8)), fill: None, multiply: false })?;
            }
        }
        Annotation::Ink { strokes, color, width, .. } => {
            for s in strokes {
                let pts: Vec<(f32, f32)> = s.iter().map(|p| (p[0], p[1])).collect();
                // A tap with the pen is a dot: a zero-length round-capped line.
                let pts = if pts.len() == 1 { vec![pts[0], (pts[0].0 + 0.01, pts[0].1)] } else { pts };
                path(page, doc, &f, &pts, false, Style { stroke: stroke(color, *width), fill: None, multiply: false })?;
            }
        }
        Annotation::Shape { shape, x0, y0, x1, y1, color, width, fill, .. } => {
            let (l, t, r, b) = (x0.min(*x1), y0.min(*y1), x0.max(*x1), y0.max(*y1));
            let st = || Style { stroke: stroke(color, *width), fill: fill.as_deref().map(colour), multiply: false };
            match shape {
                ShapeKind::Rect => path(page, doc, &f, &rect_pts(l, t, r - l, b - t), true, st())?,
                ShapeKind::Ellipse => {
                    let (cx, cy, rx, ry) = ((l + r) / 2.0, (t + b) / 2.0, (r - l) / 2.0, (b - t) / 2.0);
                    let pts: Vec<(f32, f32)> = (0..72).map(|i| {
                        let a = i as f32 / 72.0 * std::f32::consts::TAU;
                        (cx + rx * a.cos(), cy + ry * a.sin())
                    }).collect();
                    path(page, doc, &f, &pts, true, st())?;
                }
                ShapeKind::Line | ShapeKind::Arrow => {
                    path(page, doc, &f, &[(*x0, *y0), (*x1, *y1)], false, Style { stroke: stroke(color, *width), fill: None, multiply: false })?;
                    if *shape == ShapeKind::Arrow {
                        let (dx, dy) = (x1 - x0, y1 - y0);
                        let len = (dx * dx + dy * dy).sqrt();
                        if len > 0.01 {
                            let head = (width * 4.0).max(9.0).min(len * 0.5);
                            let ang = dy.atan2(dx);
                            let wing = |s: f32| (x1 - head * (ang + s).cos(), y1 - head * (ang + s).sin());
                            let (a, b) = (wing(0.5), wing(-0.5));
                            path(page, doc, &f, &[a, (*x1, *y1), b], false, Style { stroke: stroke(color, *width), fill: None, multiply: false })?;
                        }
                    }
                }
            }
        }
        Annotation::Text { x, y, text, size, color, background, w, h, .. } => {
            if let (Some(bg), Some(w), Some(h)) = (background, w, h) {
                path(page, doc, &f, &rect_pts(*x, *y, *w, *h), true, Style { stroke: None, fill: Some(colour(bg)), multiply: false })?;
            }
            let ((ra, rb), (ua, ub)) = f.axes();
            for (i, line) in text.split('\n').enumerate().filter(|(_, l)| !l.is_empty()) {
                let base = y + size * 0.85 + i as f32 * size * 1.2;
                let (ex, ey) = f.map(*x, base);
                let mut obj = PdfPageTextObject::new(doc, line.replace('\t', "    "), font, pt(*size)).map_err(e("text"))?;
                obj.set_fill_color(colour(color)).map_err(e("text"))?;
                obj.reset_matrix(PdfMatrix::new(ra, rb, ua, ub, ex, ey)).map_err(e("text"))?;
                page.objects_mut().add_text_object(obj).map_err(e("text"))?;
            }
        }
        Annotation::Image { x, y, w, h, image, .. } => {
            let img = images.get(*image as usize).ok_or("A picture refers to a file that wasn't sent.")?;
            let ((ra, rb), (ua, ub)) = f.axes();
            let (ex, ey) = f.map(*x, y + h);
            let mut obj = PdfPageImageObject::new(doc, img).map_err(e("picture"))?;
            obj.reset_matrix(PdfMatrix::new(ra * w, rb * w, ua * h, ub * h, ex, ey)).map_err(e("picture"))?;
            page.objects_mut().add_image_object(obj).map_err(e("picture"))?;
        }
    }
    Ok(())
}

/// Place a picture in the box (x, y, w, h) of the page as shown, for the images-to-PDF layout.
pub fn place_image<'a>(page: &mut PdfPage<'a>, doc: &PdfDocument<'a>, img: &DynamicImage, x: f32, y: f32, w: f32, h: f32) -> Res<()> {
    let f = Frame::of(page)?;
    let (ex, ey) = f.map(x, y + h);
    let mut obj = PdfPageImageObject::new(doc, img).map_err(e("picture"))?;
    obj.reset_matrix(PdfMatrix::new(w, 0.0, 0.0, h, ex, ey)).map_err(e("picture"))?;
    page.objects_mut().add_image_object(obj).map_err(e("picture"))?;
    Ok(())
}

/// Like [`place_image`], for a JPEG file embedded as it is.
pub fn place_jpeg<'a>(page: &mut PdfPage<'a>, doc: &PdfDocument<'a>, path: &std::path::Path, x: f32, y: f32, w: f32, h: f32) -> Res<()> {
    let f = Frame::of(page)?;
    let (ex, ey) = f.map(x, y + h);
    let mut obj = PdfPageImageObject::new_from_jpeg_file(doc, path).map_err(e("picture"))?;
    obj.reset_matrix(PdfMatrix::new(w, 0.0, 0.0, h, ex, ey)).map_err(e("picture"))?;
    page.objects_mut().add_image_object(obj).map_err(e("picture"))?;
    Ok(())
}
