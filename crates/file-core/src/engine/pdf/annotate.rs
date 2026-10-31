//! Things the user adds on top of a PDF page: highlights, underlines, strikethroughs, notes, drawings,
//! shapes, text boxes and images. They are drawn into the page content of the *new* PDF; the source is
//! never touched. Coordinates are in the page as it is shown (after the page's own /Rotate), in PDF points,
//! with the origin at the top-left and y growing downwards, which is how the editor draws them.

use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};

pub const MAX_ANNOTATIONS: usize = 5000;
pub const MAX_INK_POINTS: usize = 200_000;
pub const MAX_TEXT_CHARS: usize = 5000;
/// Largest picture, in pixels, that can be placed on a page.
pub const MAX_IMAGE_PIXELS: u64 = 40_000_000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShapeKind {
    Rect,
    Ellipse,
    Line,
    Arrow,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Annotation {
    Highlight { page: u32, rects: Vec<Rect>, color: String },
    Underline { page: u32, rects: Vec<Rect>, color: String },
    Strike { page: u32, rects: Vec<Rect>, color: String },
    /// Strokes of the pen, each a list of [x, y] points.
    Ink { page: u32, strokes: Vec<Vec<[f32; 2]>>, color: String, width: f32 },
    /// A rectangle, ellipse, line or arrow from (x0, y0) to (x1, y1). `fill` makes a closed shape solid.
    Shape { page: u32, shape: ShapeKind, x0: f32, y0: f32, x1: f32, y1: f32, color: String, width: f32, fill: Option<String> },
    /// Text at (x, y), the top-left of the first line. Line breaks are written as `\n`; the editor does the wrapping.
    /// `background` paints a box behind it (a sticky note).
    Text {
        page: u32,
        x: f32,
        y: f32,
        text: String,
        size: f32,
        color: String,
        background: Option<String>,
        /// Size of the box painted behind the text when `background` is set.
        #[serde(default)]
        w: Option<f32>,
        #[serde(default)]
        h: Option<f32>,
    },
    /// One of the extra input files (counting from 0 after the PDF), placed in the box.
    Image { page: u32, x: f32, y: f32, w: f32, h: f32, image: u32 },
}

impl Annotation {
    pub fn page(&self) -> u32 {
        match self {
            Annotation::Highlight { page, .. }
            | Annotation::Underline { page, .. }
            | Annotation::Strike { page, .. }
            | Annotation::Ink { page, .. }
            | Annotation::Shape { page, .. }
            | Annotation::Text { page, .. }
            | Annotation::Image { page, .. } => *page,
        }
    }
}

pub fn parse_colour(s: &str) -> Option<[u8; 3]> {
    let h = s.strip_prefix('#')?;
    if h.len() != 6 || !h.is_ascii() {
        return None;
    }
    Some([u8::from_str_radix(&h[0..2], 16).ok()?, u8::from_str_radix(&h[2..4], 16).ok()?, u8::from_str_radix(&h[4..6], 16).ok()?])
}

/// True if the built-in PDF fonts can draw every character. They cover Latin text (including accents), not other scripts.
pub fn drawable(text: &str) -> bool {
    text.chars().all(|c| c == '\n' || c == '\t' || (c as u32) >= 0x20 && ((c as u32) < 0x7f || (0xa0..=0xff).contains(&(c as u32)) || matches!(c, '€' | '‘' | '’' | '“' | '”' | '•' | '–' | '—' | '…' | '™' | 'Š' | 'š' | 'Ž' | 'ž' | 'Œ' | 'œ' | 'Ÿ')))
}

/// Everything that can be checked without a PDF: numbers are finite and sane, colours parse, text can be drawn,
/// image references point at real extra inputs.
pub fn validate(list: &[Annotation], extra_images: usize) -> Result<()> {
    let bad = |m: &str| Err(Error::InvalidRequest(m.into()));
    if list.len() > MAX_ANNOTATIONS {
        return bad("There are too many annotations on this document.");
    }
    let finite = |v: &[f32]| v.iter().all(|n| n.is_finite() && n.abs() < 1e6);
    let colour = |c: &str| parse_colour(c).is_some();
    let mut ink_points = 0usize;
    for a in list {
        if a.page() == 0 {
            return bad("Pages are numbered from 1.");
        }
        match a {
            Annotation::Highlight { rects, color, .. } | Annotation::Underline { rects, color, .. } | Annotation::Strike { rects, color, .. } => {
                if !colour(color) || rects.is_empty() || rects.len() > 2000 || !rects.iter().all(|r| finite(&[r.x, r.y, r.w, r.h]) && r.w >= 0.0 && r.h >= 0.0) {
                    return bad("A highlight has an invalid area or colour.");
                }
            }
            Annotation::Ink { strokes, color, width, .. } => {
                ink_points += strokes.iter().map(Vec::len).sum::<usize>();
                if !colour(color) || !finite(&[*width]) || *width <= 0.0 || *width > 200.0 || ink_points > MAX_INK_POINTS || !strokes.iter().flatten().all(|p| finite(p)) {
                    return bad("A drawing has an invalid colour, width or too many points.");
                }
            }
            Annotation::Shape { x0, y0, x1, y1, color, width, fill, .. } => {
                if !colour(color) || fill.as_deref().is_some_and(|f| !colour(f)) || !finite(&[*x0, *y0, *x1, *y1, *width]) || *width <= 0.0 || *width > 200.0 {
                    return bad("A shape has an invalid size, width or colour.");
                }
            }
            Annotation::Text { x, y, text, size, color, background, w, h, .. } => {
                if !colour(color) || background.as_deref().is_some_and(|b| !colour(b)) || !finite(&[*x, *y, *size, w.unwrap_or(0.0), h.unwrap_or(0.0)]) || *size < 1.0 || *size > 500.0 || text.chars().count() > MAX_TEXT_CHARS {
                    return bad("A text box has an invalid size, colour or is too long.");
                }
                if !drawable(text) {
                    return Err(Error::InvalidRequest(
                        "A text box contains characters the PDF's built-in fonts can't draw. Latin letters with accents are fine; other alphabets (Arabic, Chinese, …) are not supported yet.".into(),
                    ));
                }
            }
            Annotation::Image { x, y, w, h, image, .. } => {
                if !finite(&[*x, *y, *w, *h]) || *w <= 0.0 || *h <= 0.0 {
                    return bad("A picture has an invalid size.");
                }
                if *image as usize >= extra_images {
                    return bad("A picture refers to a file that wasn't sent.");
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(v: serde_json::Value) -> Vec<Annotation> {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn colours() {
        assert_eq!(parse_colour("#FFEB3B"), Some([255, 235, 59]));
        for bad in ["FFEB3B", "#FFF", "#GGGGGG", "#ÄÄÄ", ""] {
            assert!(parse_colour(bad).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn what_the_builtin_fonts_can_draw() {
        assert!(drawable("Résumé — café “quoted” 10€\nline two"));
        assert!(!drawable("日本語"));
        assert!(!drawable("مرحبا"));
        assert!(!drawable("emoji 😀"));
    }

    #[test]
    fn validation() {
        let ok = parse(serde_json::json!([
            {"kind": "highlight", "page": 1, "rects": [{"x": 1, "y": 2, "w": 30, "h": 10}], "color": "#FFEB3B"},
            {"kind": "shape", "page": 2, "shape": "arrow", "x0": 0, "y0": 0, "x1": 50, "y1": 50, "color": "#FF0000", "width": 2, "fill": null},
            {"kind": "text", "page": 1, "x": 10, "y": 10, "text": "Hello é", "size": 12, "color": "#000000", "background": "#FFF9C4", "w": 80, "h": 20},
            {"kind": "image", "page": 1, "x": 0, "y": 0, "w": 40, "h": 20, "image": 0},
            {"kind": "ink", "page": 1, "strokes": [[[0, 0], [5, 5]]], "color": "#0000FF", "width": 3}
        ]));
        assert!(validate(&ok, 1).is_ok());
        assert!(validate(&ok, 0).is_err(), "the picture needs a file");
        let no_page = parse(serde_json::json!([{"kind": "highlight", "page": 0, "rects": [{"x": 0, "y": 0, "w": 1, "h": 1}], "color": "#000000"}]));
        assert!(validate(&no_page, 0).is_err());
        let inf = parse(serde_json::json!([{"kind": "text", "page": 1, "x": 1e9, "y": 0, "text": "x", "size": 10, "color": "#000000", "background": null}]));
        assert!(validate(&inf, 0).is_err());
        let arabic = parse(serde_json::json!([{"kind": "text", "page": 1, "x": 0, "y": 0, "text": "مرحبا", "size": 10, "color": "#000000", "background": null}]));
        assert!(validate(&arabic, 0).unwrap_err().user_message().contains("built-in fonts"));
        let badc = parse(serde_json::json!([{"kind": "ink", "page": 1, "strokes": [[[0, 0]]], "color": "red", "width": 1}]));
        assert!(validate(&badc, 0).is_err());
    }
}
