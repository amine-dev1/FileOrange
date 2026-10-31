// Mirrors the Rust types serialised by src-tauri/src/commands.rs and
// crates/file-api/src/types.rs. Keep in sync when the backend changes.

export type OperationKind = "compress" | "convert" | "extract" | "pdf-merge" | "pdf-split" | "pdf-pages" | "images-to-pdf" | "pdf-to-images" | "office-to-pdf";
export type ConflictPolicy = "rename" | "replace" | "skip";
export type WebpMode = "lossy" | "lossless";

export interface AppErrorShape {
  code: string;
  message: string;
}

// ---- requests -------------------------------------------------------------
export type OperationRequest =
  | { type: "compress"; archive_name?: string | null; include_folders?: boolean }
  | { type: "extract"; password?: string | null; subfolder?: boolean; max_total_bytes?: number | null }
  | { type: "convert_image"; format: string; quality?: number; keep_metadata?: boolean; webp_mode?: WebpMode; background?: string }
  | { type: "pdf_merge"; password?: string | null; output_name?: string | null }
  | { type: "pdf_split"; mode: "every"; every: number; password?: string | null }
  | { type: "pdf_split"; mode: "ranges"; ranges: string; password?: string | null }
  /** The result is exactly these pages (numbered from 1 in the source), in this order; `rotate` adds degrees clockwise. */
  | { type: "pdf_pages"; pages: { page: number; rotate: number }[]; password?: string | null; output_name?: string | null; annotations?: Annotation[] }
  | { type: "images_to_pdf"; paper: PaperSize; orientation: PageOrientation; margin_mm: number; output_name?: string | null }
  | { type: "pdf_to_images"; format: "png" | "jpeg" | "webp"; dpi: number; pages?: string | null; quality?: number; password?: string | null }
  | { type: "office_to_pdf" };

export type PaperSize = "fit" | "a4" | "letter";
export type PageOrientation = "auto" | "portrait" | "landscape";

/** Things drawn on a page. Coordinates are in points on the page as shown, origin top-left. Mirrors file-core's `annotate.rs`. */
export interface AnnotationRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type ShapeKind = "rect" | "ellipse" | "line" | "arrow";
export type Annotation =
  | { kind: "highlight"; page: number; rects: AnnotationRect[]; color: string }
  | { kind: "underline"; page: number; rects: AnnotationRect[]; color: string }
  | { kind: "strike"; page: number; rects: AnnotationRect[]; color: string }
  | { kind: "ink"; page: number; strokes: [number, number][][]; color: string; width: number }
  | { kind: "shape"; page: number; shape: ShapeKind; x0: number; y0: number; x1: number; y1: number; color: string; width: number; fill: string | null }
  | { kind: "text"; page: number; x: number; y: number; text: string; size: number; color: string; background: string | null; w?: number | null; h?: number | null }
  /** `image` counts the extra picture files sent after the PDF, from 0. */
  | { kind: "image"; page: number; x: number; y: number; w: number; h: number; image: number };

export interface JobRequest {
  inputs: string[];
  output_dir: string;
  conflict: ConflictPolicy;
  operation: OperationRequest;
}

// ---- responses ------------------------------------------------------------
export interface Review {
  conflicts: string[];
  warnings: string[];
  errors: string[];
  needs_password: boolean;
  total_bytes: number;
}

export type WireStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type WireOutcome = "done" | "skipped" | "failed";

export interface FileOutcome {
  input: string;
  outcome: WireOutcome;
  output: string | null;
  error_code: string | null;
  message: string | null;
}

export interface JobResponse {
  job_id: string;
  operation: string;
  status: WireStatus;
  progress: {
    files_completed: number;
    files_total: number;
    percent: number;
    bytes_processed: number;
    bytes_total: number | null;
  };
  current_file: string | null;
  results: FileOutcome[];
  error: { code: string; message: string } | null;
  message: string | null;
}

export interface DesktopStatus {
  job_id: string;
  operation: string;
  phase: "uploading" | "processing" | "failed" | "cancelled";
  upload: { sent: number; total: number };
  job: JobResponse | null;
  error: AppErrorShape | null;
}

export interface DownloadSummary {
  outputs: string[];
  files_saved: number;
  files_skipped: number;
  bytes_saved: number;
}

export interface PathInfo {
  path: string;
  name: string;
  is_dir: boolean;
  size: number;
  file_count: number;
}

export interface ArchiveEntry {
  name: string;
  size: number;
  compressed_size: number;
  is_dir: boolean;
  encrypted: boolean;
  symlink: boolean;
  safe: boolean;
}

export interface ArchiveListing {
  entries: ArchiveEntry[];
  file_count: number;
  total_uncompressed: number;
  total_compressed: number;
  needs_password: boolean;
  unsafe_entries: number;
  suspicious_ratio: boolean;
}

export interface ApiStatus {
  connected: boolean;
  version: string | null;
}

// ---- UI-side job record (what the history table shows) --------------------
export type JobStatus = "uploading" | "processing" | "saving" | "completed" | "failed" | "cancelled";

export interface JobRecord {
  id: string;
  sessionId: string;
  kind: OperationKind;
  /** Primary file name shown in the table. */
  title: string;
  /** e.g. "WEBP → PNG" */
  detail: string | null;
  inputNames: string[];
  inputBytes: number;
  outputBytes: number | null;
  outputDir: string;
  outputs: string[];
  status: JobStatus;
  /** 0-100 for the current phase. */
  percent: number;
  createdAt: number;
  finishedAt: number | null;
  error: AppErrorShape | null;
  results: FileOutcome[];
  filesSaved: number | null;
  filesSkipped: number | null;
}

export const ACTIVE_STATUSES: JobStatus[] = ["uploading", "processing", "saving"];
export const isActive = (j: Pick<JobRecord, "status">) => ACTIVE_STATUSES.includes(j.status);

// ---- capabilities (GET /api/v1/capabilities, via the get_capabilities command) ----
export type Availability = { status: "bundled" } | { status: "installed" } | { status: "unavailable"; reason: string };

export interface EngineInfo {
  id: string;
  name: string;
  version: string;
  availability: Availability;
  license: string;
}

export interface EngineReport extends EngineInfo {
  operations: string[];
}

export interface ConversionPair {
  from: string;
  to: string;
  notes: string[];
}

export type OptionKind =
  | { type: "bool"; default: boolean }
  | { type: "int"; min: number; max: number; default: number }
  | { type: "choice"; choices: { value: string; label: string }[]; default: string }
  | { type: "color"; default: string }
  | { type: "text"; max_len: number }
  | { type: "secret" };

export interface OptionSpec {
  id: string;
  label: string;
  help: string | null;
  kind: OptionKind;
  /** Empty = applies to every output format. */
  applies_to: { format: string; when: { option: string; equals: string } | null }[];
}

export interface OperationReport {
  id: string;
  label: string;
  description: string;
  inputs: string[];
  outputs: string[];
  pairs: ConversionPair[];
  options: OptionSpec[];
  /** Works on a document being viewed or edited (like the PDF editor), not as a batch job. */
  interactive: boolean;
  engine: string;
  available: boolean;
  unavailable_reason: string | null;
}

export type FormatKind = "image" | "archive" | "pdf" | "document" | "audio" | "video";

export interface FormatInfo {
  id: string;
  label: string;
  extensions: string[];
  mime: string;
  kind: FormatKind;
}

export interface Limits {
  max_archive_entries: number;
  default_max_extract_bytes: number;
  max_image_dimension: number;
  max_webp_dimension: number;
  max_pdf_render_width: number;
  max_file_bytes: number | null;
  max_request_bytes: number | null;
  max_files: number | null;
  max_concurrent_jobs: number | null;
  retention_seconds: number | null;
}

export interface Capabilities {
  schema: number;
  engines: EngineReport[];
  operations: OperationReport[];
  formats: FormatInfo[];
  limits: Limits;
}

// ---- PDF documents (the open file in the PDF editor)

export interface PdfPageInfo {
  /** Size as shown on screen (after the page's own rotation), in points (1/72 inch). */
  width_pt: number;
  height_pt: number;
}

export interface PdfPermissions {
  print: boolean;
  copy: boolean;
  modify: boolean;
  annotate: boolean;
  fill_forms: boolean;
  assemble: boolean;
}

export interface PdfMetadata {
  title: string | null;
  author: string | null;
  subject: string | null;
  keywords: string | null;
  creator: string | null;
  producer: string | null;
  /** As written in the file, e.g. `D:20240102120000Z`. */
  created: string | null;
  modified: string | null;
}

export interface PdfInfo {
  page_count: number;
  pages: PdfPageInfo[];
  version: string | null;
  encrypted: boolean;
  permissions: PdfPermissions | null;
  has_form: boolean;
  signature_count: number;
  metadata: PdfMetadata;
  /** Plain-language things to know before editing, written by the engine. */
  warnings: string[];
}

export interface PdfDocument {
  id: string;
  name: string;
  size: number;
  info: PdfInfo;
}
