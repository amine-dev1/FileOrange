//! Merge, split and rearrange (reorder, rotate, delete, extract) PDFs.
//!
//! All three are the same operation underneath: build a new PDF from a list of pages taken from
//! one or more source files ([`PdfHost::assemble`]). The sources are only ever read; the result is
//! written to a temp file next to its destination and moved into place under the user's conflict
//! policy (see `fs_safe`), so a failed or cancelled job leaves nothing behind.

use super::annotate::{self, Annotation};
use super::host::AssembleSource;
use super::worker::{ImagesLayout, Orientation, PageRef, PaperSize};
use super::{PdfHost, MAX_PAGES};
use crate::engine::image::{self as imgeng, ImageOptions, OutputFormat, WebpMode};
use crate::error::{Error, Result};
use crate::formats::{self, FileDescriptor};
use crate::fs_safe::{self, Committed, ConflictPolicy};
use crate::job::{FileResult, JobContext};
use crate::request::{JobRequest, Operation, Review, Secret, MAX_CONFLICTS};
use serde::Deserialize;
use std::fs;
use std::ops::RangeInclusive;
use std::path::{Path, PathBuf};

/// Most parts one split may produce.
pub const MAX_SPLIT_PARTS: usize = 2000;

#[derive(Debug, Clone, Deserialize)]
pub struct PdfMergeOptions {
    /// One password, tried for every protected input.
    pub password: Option<Secret>,
    /// Name of the merged file, with or without `.pdf`. Default: `merged.pdf`.
    pub output_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum SplitMode {
    /// A new file for every `every` pages (1 = one file per page).
    Every { every: u32 },
    /// One file per range, e.g. `1-3, 4, 7-` (a trailing dash means "to the end").
    Ranges { ranges: String },
}

#[derive(Debug, Clone, Deserialize)]
pub struct PdfSplitOptions {
    pub password: Option<Secret>,
    #[serde(flatten)]
    pub mode: SplitMode,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct PageSpec {
    /// Page of the source file, from 1.
    pub page: u32,
    /// Extra degrees clockwise: 0, 90, 180 or 270.
    #[serde(default)]
    pub rotate: u16,
}

/// The result is exactly these pages, in this order: that is reorder, delete, extract and rotate in one.
/// The first input is the PDF. Any further inputs are pictures that `annotations` of kind `image` refer to.
#[derive(Debug, Clone, Deserialize)]
pub struct PdfPagesOptions {
    pub pages: Vec<PageSpec>,
    pub password: Option<Secret>,
    pub output_name: Option<String>,
    /// Things drawn on the pages. `page` of each is a page of the source PDF.
    #[serde(default)]
    pub annotations: Vec<Annotation>,
}

fn paper_default() -> PaperSize {
    PaperSize::A4
}
fn orientation_default() -> Orientation {
    Orientation::Auto
}
fn margin_default() -> f32 {
    10.0
}
fn dpi_default() -> u32 {
    150
}
fn quality_default() -> u8 {
    90
}

/// One page per picture, in the order the pictures were sent.
#[derive(Debug, Clone, Deserialize)]
pub struct ImagesToPdfOptions {
    #[serde(default = "paper_default")]
    pub paper: PaperSize,
    #[serde(default = "orientation_default")]
    pub orientation: Orientation,
    #[serde(default = "margin_default")]
    pub margin_mm: f32,
    pub output_name: Option<String>,
}

/// Save pages of each PDF as pictures.
#[derive(Debug, Clone, Deserialize)]
pub struct PdfToImagesOptions {
    pub format: OutputFormat,
    /// Dots per inch the page is drawn at (a page is 72 points per inch).
    #[serde(default = "dpi_default")]
    pub dpi: u32,
    /// Which pages, e.g. `1-3, 5, 9-`. All pages if absent.
    pub pages: Option<String>,
    /// For JPG and WebP.
    #[serde(default = "quality_default")]
    pub quality: u8,
    pub password: Option<Secret>,
}

pub const MIN_DPI: u32 = 36;
pub const MAX_DPI: u32 = 600;
/// Most pictures one job may write.
pub const MAX_EXPORT_PAGES: usize = 5000;

// ------------------------------------------------------------------ page ranges

/// Parse `1-3, 5, 7-` against a document of `count` pages. Ranges are returned as written (they may overlap).
pub fn parse_ranges(text: &str, count: u32) -> Result<Vec<RangeInclusive<u32>>> {
    let bad = |m: String| Err(Error::InvalidRequest(m));
    let mut out = Vec::new();
    for part in text.split([',', ';']).map(str::trim).filter(|p| !p.is_empty()) {
        let num = |s: &str| s.trim().parse::<u32>().ok().filter(|n| *n >= 1);
        let (a, b) = match part.split_once('-') {
            None => match num(part) {
                Some(n) => (n, n),
                None => return bad(format!("“{part}” isn't a page number. Use numbers and ranges like 1-3, 5, 7-.")),
            },
            Some((from, to)) => {
                let Some(a) = num(from) else { return bad(format!("“{part}” isn't a page range. Use numbers and ranges like 1-3, 5, 7-.")) };
                let b = if to.trim().is_empty() { count } else { num(to).unwrap_or(0) };
                if b == 0 {
                    return bad(format!("“{part}” isn't a page range. Use numbers and ranges like 1-3, 5, 7-."));
                }
                (a, b)
            }
        };
        if a > b {
            return bad(format!("“{part}” goes backwards. Write the lower page first."));
        }
        for n in [a, b] {
            if n > count {
                return bad(if count == u32::MAX { format!("“{part}” is not a valid page range.") } else { format!("Page {n} is past the end: this PDF has {count} page{}.", if count == 1 { "" } else { "s" }) });
            }
        }
        out.push(a..=b);
        if out.len() > MAX_SPLIT_PARTS {
            return bad(format!("That is more than {MAX_SPLIT_PARTS} parts."));
        }
    }
    if out.is_empty() {
        return bad("Enter the pages for each new file, for example 1-3, 4-6.".into());
    }
    Ok(out)
}

/// The page ranges a split makes for a document of `count` pages.
pub fn split_ranges(mode: &SplitMode, count: u32) -> Result<Vec<RangeInclusive<u32>>> {
    match mode {
        SplitMode::Every { every } => {
            if *every == 0 {
                return Err(Error::InvalidRequest("Pages per file must be at least 1.".into()));
            }
            let parts = count.div_ceil(*every) as usize;
            if parts > MAX_SPLIT_PARTS {
                return Err(Error::InvalidRequest(format!("That would make {parts} files; the limit is {MAX_SPLIT_PARTS}. Choose more pages per file.")));
            }
            Ok((0..parts as u32).map(|i| (i * every + 1)..=((i + 1) * every).min(count)).collect())
        }
        SplitMode::Ranges { ranges } => parse_ranges(ranges, count),
    }
}

// ------------------------------------------------------------------ names

fn stem_of(p: &Path) -> String {
    p.file_stem().map(|s| s.to_string_lossy().into_owned()).filter(|s| !s.is_empty()).unwrap_or_else(|| "document".into())
}

/// `name` (with or without `.pdf`) as a safe file name ending in `.pdf`.
fn pdf_file_name(name: Option<&str>, default_stem: &str) -> Result<String> {
    let given = name.map(str::trim).filter(|n| !n.is_empty()).unwrap_or(default_stem);
    let stem = match given.len().checked_sub(4).and_then(|i| given.get(i..)) {
        Some(tail) if tail.eq_ignore_ascii_case(".pdf") => &given[..given.len() - 4],
        _ => given,
    };
    fs_safe::safe_file_name(&format!("{stem}.pdf")).map_err(|_| Error::InvalidRequest("That isn't a usable file name.".into()))
}

fn part_name(stem: &str, r: &RangeInclusive<u32>) -> Result<String> {
    let (a, b) = (*r.start(), *r.end());
    let label = if a == b { format!("page {a}") } else { format!("pages {a}-{b}") };
    pdf_file_name(Some(&format!("{stem} - {label}")), "document")
}

fn split_dir(output_dir: &Path, source: &Path, policy: ConflictPolicy) -> PathBuf {
    split_dir_named(output_dir, source, "split", policy)
}

/// `<name> (<what>)` inside the output folder; with Keep both, a fresh one if it already exists.
fn split_dir_named(output_dir: &Path, source: &Path, what: &str, policy: ConflictPolicy) -> PathBuf {
    let dir = output_dir.join(format!("{} ({what})", stem_of(source)));
    if policy == ConflictPolicy::Rename && fs::symlink_metadata(&dir).is_ok() {
        fs_safe::unique_path(&dir)
    } else {
        dir
    }
}

// ------------------------------------------------------------------ validation

/// Option and file-type checks that need no disk access (see `Engine::preflight`).
pub fn preflight(op: &Operation, files: &[FileDescriptor], strict: bool) -> Result<()> {
    let is_image = |f: &str| matches!(f, formats::JPEG | formats::PNG | formats::WEBP);
    let allowed = |f: &str| match op {
        Operation::ImagesToPdf(_) => is_image(f),
        // The first file is the PDF, the rest are pictures for annotations; the job checks which is which.
        Operation::PdfPages(_) => f == formats::PDF || is_image(f),
        _ => f == formats::PDF,
    };
    for f in files {
        match f.format.as_deref() {
            Some(fmt) if allowed(fmt) => {}
            Some(_) => return Err(Error::UnsupportedFormat(f.name.clone())),
            None if strict => return Err(Error::UnsupportedFormat(f.name.clone())),
            None => {}
        }
    }
    match op {
        Operation::PdfMerge(o) => {
            pdf_file_name(o.output_name.as_deref(), "merged")?;
        }
        Operation::PdfSplit(o) => {
            match &o.mode {
                SplitMode::Every { every } if *every == 0 => return Err(Error::InvalidRequest("Pages per file must be at least 1.".into())),
                SplitMode::Ranges { ranges } => {
                    parse_ranges(ranges, u32::MAX)?;
                }
                _ => {}
            }
        }
        Operation::PdfPages(o) => {
            if o.pages.is_empty() {
                return Err(Error::InvalidRequest("Keep at least one page.".into()));
            }
            if o.pages.len() as u32 > MAX_PAGES {
                return Err(Error::InvalidRequest(format!("A PDF can have at most {MAX_PAGES} pages here.")));
            }
            if o.pages.iter().any(|p| p.page == 0 || p.rotate % 90 != 0 || p.rotate >= 360) {
                return Err(Error::InvalidRequest("Pages are numbered from 1 and can be turned by 90, 180 or 270 degrees.".into()));
            }
            annotate::validate(&o.annotations, usize::MAX)?;
            pdf_file_name(o.output_name.as_deref(), "edited")?;
        }
        Operation::ImagesToPdf(o) => {
            if !o.margin_mm.is_finite() || !(0.0..=100.0).contains(&o.margin_mm) {
                return Err(Error::InvalidRequest("The margin must be between 0 and 100 mm.".into()));
            }
            pdf_file_name(o.output_name.as_deref(), "images")?;
        }
        Operation::PdfToImages(o) => {
            if !(MIN_DPI..=MAX_DPI).contains(&o.dpi) {
                return Err(Error::InvalidRequest(format!("The resolution must be between {MIN_DPI} and {MAX_DPI} dpi.")));
            }
            if !(1..=100).contains(&o.quality) {
                return Err(Error::InvalidRequest("Quality must be between 1 and 100.".into()));
            }
            if let Some(p) = &o.pages {
                parse_ranges(p, u32::MAX)?;
            }
        }
        _ => return Err(Error::Unsupported("the PDF engine does not handle this operation".into())),
    }
    Ok(())
}

fn display(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

fn password_of(op: &Operation) -> Option<&Secret> {
    match op {
        Operation::PdfMerge(o) => o.password.as_ref(),
        Operation::PdfSplit(o) => o.password.as_ref(),
        Operation::PdfPages(o) => o.password.as_ref(),
        Operation::PdfToImages(o) => o.password.as_ref(),
        _ => None,
    }
}

const CARRY_OVER: &str = "The new PDF keeps how every page looks. Document-level extras such as bookmarks, form-filling data and properties (title, author) are not carried over.";

// ------------------------------------------------------------------ review

pub fn review(host: &PdfHost, req: &JobRequest) -> Result<Review> {
    let mut r = Review::default();
    r.total_bytes = req.inputs.iter().filter_map(|p| fs::metadata(p).ok()).map(|m| m.len()).sum();
    if matches!(req.operation, Operation::PdfMerge(_) | Operation::PdfSplit(_) | Operation::PdfPages(_)) {
        r.warnings.push(CARRY_OVER.into());
        if password_of(&req.operation).is_some() {
            r.warnings.push("The new PDF is not password-protected, even though the original is.".into());
        }
    }
    let conflict = |r: &mut Review, p: PathBuf| {
        if fs::symlink_metadata(&p).is_ok() && r.conflicts.len() < MAX_CONFLICTS {
            r.conflicts.push(p);
        }
    };
    match &req.operation {
        Operation::PdfMerge(o) => {
            if req.inputs.len() < 2 {
                r.errors.push("Choose at least two PDFs to merge.".into());
            }
            match pdf_file_name(o.output_name.as_deref(), "merged") {
                Ok(n) => conflict(&mut r, req.output_dir.join(n)),
                Err(e) => r.errors.push(e.user_message()),
            }
        }
        Operation::PdfPages(o) => {
            if req.inputs.is_empty() {
                r.errors.push("Choose one PDF.".into());
            } else if let Err(e) = annotate::validate(&o.annotations, req.inputs.len() - 1) {
                r.errors.push(e.user_message());
            } else {
                if !o.annotations.is_empty() {
                    r.warnings.push("Annotations are drawn into the pages of the new PDF. They look the same everywhere, but can't be edited or removed later.".into());
                }
                match pdf_file_name(o.output_name.as_deref(), &format!("{} (edited)", stem_of(&req.inputs[0]))) {
                    Ok(n) => conflict(&mut r, req.output_dir.join(n)),
                    Err(e) => r.errors.push(e.user_message()),
                }
            }
        }
        Operation::PdfSplit(o) => {
            if req.inputs.len() != 1 {
                r.errors.push("Choose one PDF to split.".into());
            } else {
                // Opening the file is the only way to know how many pages there are, so how many files come out.
                match host.info(&req.inputs[0], o.password.as_ref()) {
                    Err(Error::PasswordRequired) => r.needs_password = true,
                    Err(e) => r.errors.push(e.user_message()),
                    Ok(info) => match split_ranges(&o.mode, info.page_count) {
                        Err(e) => r.errors.push(e.user_message()),
                        Ok(parts) => {
                            r.warnings.push(format!("This will make {} new PDF{}.", parts.len(), if parts.len() == 1 { "" } else { "s" }));
                            let dir = split_dir(&req.output_dir, &req.inputs[0], req.conflict);
                            let stem = stem_of(&req.inputs[0]);
                            for p in &parts {
                                if let Ok(n) = part_name(&stem, p) {
                                    conflict(&mut r, dir.join(n));
                                }
                            }
                        }
                    },
                }
            }
        }
        Operation::ImagesToPdf(o) => {
            if req.inputs.is_empty() {
                r.errors.push("Choose at least one picture.".into());
            }
            match pdf_file_name(o.output_name.as_deref(), &images_default_name(&req.inputs)) {
                Ok(n) => conflict(&mut r, req.output_dir.join(n)),
                Err(e) => r.errors.push(e.user_message()),
            }
            if matches!(o.paper, PaperSize::Fit) {
                r.warnings.push("Each page will be as large as its picture (at 96 dpi), so pages can differ in size.".into());
            }
        }
        Operation::PdfToImages(o) => {
            let ext = o.format.extension();
            for file in &req.inputs {
                match host.info(file, o.password.as_ref()) {
                    Err(Error::PasswordRequired) => r.needs_password = true,
                    Err(e) => r.errors.push(format!("{}: {}", display(file), e.user_message())),
                    Ok(info) => match export_pages(o, info.page_count) {
                        Err(e) => r.errors.push(format!("{}: {}", display(file), e.user_message())),
                        Ok(list) => {
                            r.warnings.push(format!("{}: {} picture{} will be made.", display(file), list.len(), if list.len() == 1 { "" } else { "s" }));
                            let dir = split_dir_named(&req.output_dir, file, "images", req.conflict);
                            let stem = stem_of(file);
                            for n in &list {
                                if let Ok(name) = picture_name(&stem, *n, info.page_count, ext) {
                                    conflict(&mut r, dir.join(name));
                                }
                            }
                        }
                    },
                }
            }
            if matches!(o.format, OutputFormat::Jpeg | OutputFormat::Webp) {
                r.warnings.push(format!("{} is lossy: quality is reduced slightly (quality {}).", if o.format == OutputFormat::Jpeg { "JPG" } else { "WebP" }, o.quality));
            }
        }
        _ => return Err(Error::Unsupported("the PDF engine does not handle this operation".into())),
    }
    Ok(r)
}

// ------------------------------------------------------------------ run

pub fn run(host: &PdfHost, req: &JobRequest, ctx: &JobContext) -> Result<()> {
    match &req.operation {
        Operation::PdfMerge(o) => merge(host, req, o, ctx),
        Operation::PdfSplit(o) => split(host, req, o, ctx),
        Operation::PdfPages(o) => pages(host, req, o, ctx),
        Operation::ImagesToPdf(o) => images_to_pdf(host, req, o, ctx),
        Operation::PdfToImages(o) => pdf_to_images(host, req, o, ctx),
        _ => Err(Error::Unsupported("the PDF engine does not handle this operation".into())),
    }
}

/// "“name”: reason", so a failure in a batch says which file it was about.
fn about(file: &Path, e: Error) -> Error {
    match e {
        Error::Cancelled => e,
        other => Error::InvalidRequest(format!("“{}”: {}", display(file), other.user_message())),
    }
}

#[allow(clippy::too_many_arguments)]
fn write_one(
    host: &PdfHost,
    sources: &[AssembleSource],
    inputs: &[PathBuf],
    pages: &[PageRef],
    annotations: &[Annotation],
    pictures: &[PathBuf],
    desired: &Path,
    policy: ConflictPolicy,
    ctx: &JobContext,
) -> Result<Committed> {
    let dir = desired.parent().unwrap_or(Path::new("."));
    // Don't do the work when the answer is already "leave it alone".
    if fs_safe::resolve_destination(desired, policy, inputs)? == fs_safe::Resolved::Skip {
        return Ok(Committed::Skipped);
    }
    let tmp = fs_safe::temp_in(dir)?;
    host.assemble(sources, pages, annotations, pictures, tmp.path(), Some(&ctx.cancel_token())).map_err(|f| match f.input.and_then(|i| inputs.get(i)) {
        Some(file) => about(file, f.error),
        None => f.error,
    })?;
    fs_safe::commit(tmp, desired, policy, inputs)
}

fn report(ctx: &JobContext, name: &str, outcome: Committed) {
    match outcome {
        Committed::Written(p) => {
            ctx.add_output(p.clone());
            ctx.add_result(FileResult::done(name, p, None));
        }
        Committed::Skipped => ctx.add_result(FileResult::skipped(name, "A file with this name already exists, so it was skipped.")),
    }
}

fn merge(host: &PdfHost, req: &JobRequest, o: &PdfMergeOptions, ctx: &JobContext) -> Result<()> {
    if req.inputs.len() < 2 {
        return Err(Error::InvalidRequest("Choose at least two PDFs to merge.".into()));
    }
    let name = pdf_file_name(o.output_name.as_deref(), "merged")?;
    ctx.set_totals(req.inputs.len() as u64 + 1, None);
    ctx.begin_file(&name);

    // Count each file's pages first. This also finds a damaged or protected file before any output exists.
    let mut pages = Vec::new();
    for (i, file) in req.inputs.iter().enumerate() {
        ctx.check_cancelled()?;
        let info = host.info(file, o.password.as_ref()).map_err(|e| {
            ctx.add_result(FileResult::failed(display(file), &e));
            about(file, e)
        })?;
        pages.extend((1..=info.page_count).map(|page| PageRef { input: i as u32, page, rotate: 0 }));
        ctx.file_processed();
    }
    if pages.len() as u32 > MAX_PAGES {
        return Err(Error::InvalidRequest(format!("Together these PDFs have {} pages; at most {MAX_PAGES} fit in one PDF here.", pages.len())));
    }
    ctx.check_cancelled()?;
    let sources: Vec<_> = req.inputs.iter().map(|f| AssembleSource { file: f, password: o.password.as_ref() }).collect();
    let outcome = write_one(host, &sources, &req.inputs, &pages, &[], &[], &req.output_dir.join(&name), req.conflict, ctx)?;
    ctx.file_processed();
    report(ctx, &name, outcome);
    Ok(())
}

fn pages(host: &PdfHost, req: &JobRequest, o: &PdfPagesOptions, ctx: &JobContext) -> Result<()> {
    let Some(input) = req.inputs.first() else {
        return Err(Error::InvalidRequest("Choose one PDF.".into()));
    };
    let pictures = &req.inputs[1..];
    preflight(&req.operation, &[], false)?;
    annotate::validate(&o.annotations, pictures.len())?;
    for p in pictures {
        if !matches!(formats::detect_file(p), Some(formats::JPEG | formats::PNG | formats::WEBP)) {
            return Err(Error::InvalidRequest(format!("“{}” isn't a JPG, PNG or WebP picture.", display(p))));
        }
    }
    let name = pdf_file_name(o.output_name.as_deref(), &format!("{} (edited)", stem_of(input)))?;
    ctx.set_totals(1, None);
    ctx.begin_file(&name);
    let plan: Vec<PageRef> = o.pages.iter().map(|p| PageRef { input: 0, page: p.page, rotate: p.rotate }).collect();
    let sources = [AssembleSource { file: input, password: o.password.as_ref() }];
    let outcome = write_one(host, &sources, &req.inputs, &plan, &o.annotations, pictures, &req.output_dir.join(&name), req.conflict, ctx)?;
    ctx.file_processed();
    report(ctx, &name, outcome);
    Ok(())
}

fn split(host: &PdfHost, req: &JobRequest, o: &PdfSplitOptions, ctx: &JobContext) -> Result<()> {
    let [input] = req.inputs.as_slice() else {
        return Err(Error::InvalidRequest("Choose one PDF to split.".into()));
    };
    let info = host.info(input, o.password.as_ref()).map_err(|e| about(input, e))?;
    let parts = split_ranges(&o.mode, info.page_count)?;
    let stem = stem_of(input);
    let dir = split_dir(&req.output_dir, input, req.conflict);
    let existed = fs::symlink_metadata(&dir).is_ok();
    fs::create_dir_all(&dir).map_err(|e| Error::from(e).at(&dir))?;
    ctx.set_totals(parts.len() as u64, None);

    let sources = [AssembleSource { file: input, password: o.password.as_ref() }];
    let mut written = 0usize;
    for range in &parts {
        if let Err(e) = ctx.check_cancelled() {
            if !existed && written == 0 {
                let _ = fs::remove_dir(&dir);
            }
            return Err(e);
        }
        let name = part_name(&stem, range)?;
        ctx.begin_file(&name);
        let plan: Vec<PageRef> = range.clone().map(|page| PageRef { input: 0, page, rotate: 0 }).collect();
        match write_one(host, &sources, &req.inputs, &plan, &[], &[], &dir.join(&name), req.conflict, ctx) {
            Ok(outcome) => {
                written += matches!(outcome, Committed::Written(_)) as usize;
                report_part(ctx, &name, outcome);
            }
            Err(Error::Cancelled) => {
                if !existed && written == 0 {
                    let _ = fs::remove_dir(&dir);
                }
                return Err(Error::Cancelled);
            }
            Err(e) => ctx.add_result(FileResult::failed(name, &e)),
        }
        ctx.file_processed();
    }
    if written > 0 {
        ctx.add_output(dir);
    } else if !existed {
        let _ = fs::remove_dir(&dir);
    }
    Ok(())
}

/// Like [`report`], but the folder (not each part) is the job's output, added once at the end.
fn report_part(ctx: &JobContext, name: &str, outcome: Committed) {
    match outcome {
        Committed::Written(p) => ctx.add_result(FileResult::done(name, p, None)),
        Committed::Skipped => ctx.add_result(FileResult::skipped(name, "A file with this name already exists, so it was skipped.")),
    }
}

// ------------------------------------------------------------------ pictures <-> PDF

fn images_default_name(inputs: &[PathBuf]) -> String {
    match inputs {
        [one] => stem_of(one),
        _ => "images".into(),
    }
}

fn images_to_pdf(host: &PdfHost, req: &JobRequest, o: &ImagesToPdfOptions, ctx: &JobContext) -> Result<()> {
    if req.inputs.is_empty() {
        return Err(Error::InvalidRequest("Choose at least one picture.".into()));
    }
    preflight(&req.operation, &[], false)?;
    for p in &req.inputs {
        if !matches!(formats::detect_file(p), Some(formats::JPEG | formats::PNG | formats::WEBP)) {
            ctx.add_result(FileResult::failed(display(p), &Error::UnsupportedFormat(display(p))));
            return Err(Error::InvalidRequest(format!("“{}” isn't a JPG, PNG or WebP picture.", display(p))));
        }
    }
    let name = pdf_file_name(o.output_name.as_deref(), &images_default_name(&req.inputs))?;
    ctx.set_totals(1, Some(req.inputs.iter().filter_map(|p| fs::metadata(p).ok()).map(|m| m.len()).sum()));
    ctx.begin_file(&name);
    let layout = ImagesLayout { paper: o.paper, orientation: o.orientation, margin_pt: o.margin_mm * 72.0 / 25.4 };
    let desired = req.output_dir.join(&name);
    let outcome = {
        if fs_safe::resolve_destination(&desired, req.conflict, &req.inputs)? == fs_safe::Resolved::Skip {
            Committed::Skipped
        } else {
            let tmp = fs_safe::temp_in(&req.output_dir)?;
            host.images_to_pdf(&req.inputs, layout, tmp.path(), Some(&ctx.cancel_token())).map_err(|f| match f.input.and_then(|i| req.inputs.get(i)) {
                Some(file) => about(file, f.error),
                None => f.error,
            })?;
            fs_safe::commit(tmp, &desired, req.conflict, &req.inputs)?
        }
    };
    ctx.file_processed();
    report(ctx, &name, outcome);
    Ok(())
}

/// The page numbers (from 1) an export covers, ascending and without repeats.
fn export_pages(o: &PdfToImagesOptions, count: u32) -> Result<Vec<u32>> {
    let list: Vec<u32> = match o.pages.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        None => (1..=count).collect(),
        Some(text) => {
            let mut v: Vec<u32> = parse_ranges(text, count)?.into_iter().flatten().collect();
            v.sort_unstable();
            v.dedup();
            v
        }
    };
    if list.len() > MAX_EXPORT_PAGES {
        return Err(Error::InvalidRequest(format!("That is more than {MAX_EXPORT_PAGES} pictures in one job.")));
    }
    Ok(list)
}

/// `<name> - page 007.png`: numbers are padded so the files sort in page order.
fn picture_name(stem: &str, page: u32, count: u32, ext: &str) -> Result<String> {
    let digits = count.to_string().len();
    let name = format!("{stem} - page {page:0digits$}.{ext}");
    fs_safe::safe_file_name(&name).map_err(|_| Error::InvalidRequest("That isn't a usable file name.".into()))
}

fn pdf_to_images(host: &PdfHost, req: &JobRequest, o: &PdfToImagesOptions, ctx: &JobContext) -> Result<()> {
    preflight(&req.operation, &[], false)?;
    if req.inputs.is_empty() {
        return Err(Error::InvalidRequest("Choose a PDF.".into()));
    }
    // Know every file's pages first: totals for progress, and a bad file or range fails before anything is written.
    let mut plans = Vec::new();
    for file in &req.inputs {
        ctx.check_cancelled()?;
        let info = host.info(file, o.password.as_ref()).map_err(|e| about(file, e))?;
        let list = export_pages(o, info.page_count).map_err(|e| about(file, e))?;
        plans.push((file, info, list));
    }
    let total: usize = plans.iter().map(|p| p.2.len()).sum();
    ctx.set_totals(total as u64, None);
    let opts = ImageOptions { quality: o.quality, webp_mode: WebpMode::Lossy, ..ImageOptions::convert_to(o.format) };

    for (file, info, list) in &plans {
        let stem = stem_of(file);
        let dir = split_dir_named(&req.output_dir, file, "images", req.conflict);
        let existed = fs::symlink_metadata(&dir).is_ok();
        fs::create_dir_all(&dir).map_err(|e| Error::from(e).at(&dir))?;
        let mut written = 0usize;
        for &n in list {
            let cleanup = |written: usize| {
                if !existed && written == 0 {
                    let _ = fs::remove_dir(&dir);
                }
            };
            if let Err(e) = ctx.check_cancelled() {
                cleanup(written);
                return Err(e);
            }
            let name = picture_name(&stem, n, info.page_count, o.format.extension())?;
            ctx.begin_file(&name);
            match export_one(host, file, o, &opts, info, n, &dir.join(&name), req, ctx) {
                Ok((outcome, note)) => {
                    match outcome {
                        Committed::Written(p) => {
                            written += 1;
                            ctx.add_result(FileResult::done(&name, p, note));
                        }
                        Committed::Skipped => ctx.add_result(FileResult::skipped(&name, "A file with this name already exists, so it was skipped.")),
                    }
                }
                Err(Error::Cancelled) => {
                    cleanup(written);
                    return Err(Error::Cancelled);
                }
                Err(e) => ctx.add_result(FileResult::failed(&name, &e)),
            }
            ctx.file_processed();
        }
        if written > 0 {
            ctx.add_output(dir);
        } else if !existed {
            let _ = fs::remove_dir(&dir);
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn export_one(
    host: &PdfHost,
    file: &Path,
    o: &PdfToImagesOptions,
    opts: &ImageOptions,
    info: &super::PdfInfo,
    page: u32,
    desired: &Path,
    req: &JobRequest,
    ctx: &JobContext,
) -> Result<(Committed, Option<String>)> {
    let dir = desired.parent().unwrap_or(Path::new("."));
    if fs_safe::resolve_destination(desired, req.conflict, &req.inputs)? == fs_safe::Resolved::Skip {
        return Ok((Committed::Skipped, None));
    }
    let want = (info.pages[page as usize - 1].width_pt * o.dpi as f32 / 72.0).round().max(1.0) as u32;
    let png = fs_safe::temp_in(dir)?;
    let drawn = host.export_page(file, o.password.as_ref(), page - 1, want, png.path(), Some(&ctx.cancel_token()))?;
    let note = (f64::from(drawn.width) < f64::from(want) * 0.98)
        .then(|| format!("Drawn at a reduced size ({}×{} px) because the page is very large.", drawn.width, drawn.height));
    let tmp = if o.format == OutputFormat::Png {
        png
    } else {
        let img = image::ImageReader::open(png.path()).and_then(|r| r.with_guessed_format()).map_err(Error::from)?.decode().map_err(Error::from)?;
        drop(png);
        let out = fs_safe::temp_in(dir)?;
        {
            let mut w = std::io::BufWriter::new(out.as_file());
            imgeng::encode(&img, o.format, opts, None, None, &mut w)?;
            std::io::Write::flush(&mut w).map_err(|e| Error::from(e).at(dir))?;
        }
        out
    };
    ctx.check_cancelled()?;
    Ok((fs_safe::commit(tmp, desired, req.conflict, &req.inputs)?, note))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(parse_ranges("1-3, 5 ; 7-", 9).unwrap(), vec![1..=3, 5..=5, 7..=9]);
        assert_eq!(parse_ranges(" 2 ", 2).unwrap(), vec![2..=2]);
        for bad in ["", " , ", "0", "x", "3-1", "1-", "-3", "1-x", "1--2", "1.5"] {
            let r = parse_ranges(bad, if bad == "1-" { 0 } else { 9 });
            if bad == "1-" {
                assert!(r.is_err(), "open range on an empty count");
            } else {
                assert!(r.is_err(), "{bad:?} should be refused");
            }
        }
        let e = parse_ranges("4-12", 10).unwrap_err().user_message();
        assert!(e.contains("Page 12") && e.contains("10 pages"), "{e}");
        assert!(parse_ranges("1-1000000", u32::MAX).is_ok(), "no document known yet: only syntax is checked");
        let many = (1..=2001).map(|i| i.to_string()).collect::<Vec<_>>().join(",");
        assert!(parse_ranges(&many, 5000).is_err(), "too many parts");
    }

    #[test]
    fn splitting_every_n() {
        let r = split_ranges(&SplitMode::Every { every: 4 }, 10).unwrap();
        assert_eq!(r, vec![1..=4, 5..=8, 9..=10]);
        assert_eq!(split_ranges(&SplitMode::Every { every: 1 }, 3).unwrap(), vec![1..=1, 2..=2, 3..=3]);
        assert_eq!(split_ranges(&SplitMode::Every { every: 50 }, 3).unwrap(), vec![1..=3]);
        assert!(split_ranges(&SplitMode::Every { every: 0 }, 3).is_err());
        assert!(split_ranges(&SplitMode::Every { every: 1 }, 5000).is_err(), "more than the part limit");
    }

    #[test]
    fn names_are_safe_and_end_in_pdf() {
        assert_eq!(pdf_file_name(None, "merged").unwrap(), "merged.pdf");
        assert_eq!(pdf_file_name(Some("  Report.PDF "), "x").unwrap(), "Report.pdf");
        assert_eq!(pdf_file_name(Some("a.b"), "x").unwrap(), "a.b.pdf");
        for bad in ["../x", "a/b", "a\\b", "CON", "x\0y"] {
            assert!(pdf_file_name(Some(bad), "x").is_err(), "{bad:?}");
        }
        assert_eq!(part_name("Doc", &(2..=2)).unwrap(), "Doc - page 2.pdf");
        assert_eq!(part_name("Doc", &(2..=5)).unwrap(), "Doc - pages 2-5.pdf");
    }
}
