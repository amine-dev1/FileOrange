// Wire types of the engine API (crates/file-api/src/types.rs) plus the capability report and the annotation model
// (crates/file-core). The browser talks to the API directly, so these are the real response shapes.

export type ToolId = "compress" | "convert" | "resize" | "extract" | "pdf-merge" | "pdf-split" | "pdf-pages" | "images-to-pdf" | "pdf-to-images" | "office-to-pdf";

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
  progress: { files_completed: number; files_total: number; percent: number; bytes_processed: number; bytes_total: number | null };
  current_file: string | null;
  results: FileOutcome[];
  error: { code: string; message: string } | null;
  message: string | null;
}

export interface ResultManifest {
  files: { index: number; path: string; size: number }[];
  directories: string[];
}

export interface MeResponse {
  /** `local` for a local engine, `anonymous` for a visitor to a hosted server. */
  tier: string;
  limits: { max_file_bytes: number; max_request_bytes: number; max_files: number; daily_bytes: number | null; max_active_jobs: number | null };
  usage: { bytes_today: number; jobs_this_hour: number };
}

export interface PreviewResponse {
  ok: boolean;
  operation: string;
  engine: { id: string; version: string } | null;
  errors: { code: string; message: string; file: string | null }[];
  warnings: string[];
}

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


export interface PdfDocumentResponse {
  id: string;
  name: string;
  size: number;
  info: PdfInfo;
}
