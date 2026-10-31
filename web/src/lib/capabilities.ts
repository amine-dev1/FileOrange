/**
 * Everything the UI knows about what the app can do comes from the backend's
 * capability report. These helpers turn that report into the answers screens
 * need; no screen hard-codes a format, a pair or an engine.
 */
import type { Capabilities, FormatInfo, OperationReport, OptionSpec } from "./types";
import { extensionOf } from "./format";

export type OperationState =
  | { state: "ready"; op: OperationReport }
  /** The operation exists but its engine can't be used right now. */
  | { state: "unavailable"; op: OperationReport; reason: string }
  /** This build doesn't have the operation at all. */
  | { state: "missing"; reason: string };

export function operationState(caps: Capabilities, id: string): OperationState {
  const op = caps.operations.find((o) => o.id === id);
  if (!op) return { state: "missing", reason: "This isn't available in this version of OrangeFile yet." };
  if (!op.available) return { state: "unavailable", op, reason: op.unavailable_reason ?? "Its engine isn't available." };
  return { state: "ready", op };
}

export const formatById = (caps: Capabilities, id: string): FormatInfo | undefined => caps.formats.find((f) => f.id === id);
export const formatLabel = (caps: Capabilities, id: string): string => formatById(caps, id)?.label ?? id.toUpperCase();

/** A hint from the file name only. The backend always checks the real content. */
export function formatForFileName(caps: Capabilities, name: string): FormatInfo | null {
  const ext = extensionOf(name);
  return ext ? (caps.formats.find((f) => f.extensions.includes(ext)) ?? null) : null;
}

export const labels = (caps: Capabilities, ids: string[]): string => ids.map((i) => formatLabel(caps, i)).join(", ");

/** File-dialog extensions for a set of format ids. */
export function extensionsFor(caps: Capabilities, ids: string[]): string[] {
  return caps.formats.filter((f) => ids.includes(f.id)).flatMap((f) => f.extensions);
}

/** Output formats every one of the chosen inputs can be converted to. */
export function outputsForInputs(op: OperationReport, inputFormats: string[]): string[] {
  const unique = [...new Set(inputFormats)];
  if (unique.length === 0) return op.outputs;
  return op.outputs.filter((to) => unique.every((from) => op.pairs.some((p) => p.from === from && p.to === to)));
}

/** What the user should know about converting these inputs to this output. */
export function pairNotes(op: OperationReport, inputFormats: string[], to: string): string[] {
  const notes = new Set<string>();
  for (const from of new Set(inputFormats)) for (const n of op.pairs.find((p) => p.from === from && p.to === to)?.notes ?? []) notes.add(n);
  return [...notes];
}

/** Does this option matter for the chosen output (and the current values of other options)? */
export function optionApplies(spec: OptionSpec, outputFormat: string, values: Record<string, unknown>): boolean {
  if (spec.applies_to.length === 0) return true;
  return spec.applies_to.some((a) => a.format === outputFormat && (!a.when || String(values[a.when.option]) === a.when.equals));
}

export function defaultOptionValues(op: OperationReport): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const o of op.options) if (o.kind.type !== "secret" && o.kind.type !== "text") out[o.id] = o.kind.default;
  return out;
}

export interface ToolChoice {
  id: string;
  label: string;
  enabled: boolean;
  /** Why it's off, or what to expect. */
  reason: string | null;
}

/** Which tools can act on the selected files, and why the others can't. */
export function toolsForFiles(caps: Capabilities, files: { name: string; isDir?: boolean }[]): ToolChoice[] {
  const kinds = files.map((f) => (f.isDir ? null : formatForFileName(caps, f.name)));
  const allIn = (ids: string[]) => files.length > 0 && kinds.every((k) => k && ids.includes(k.id));
  const choice = (id: string, label: string, fits: (op: OperationReport) => string | null): ToolChoice => {
    const st = operationState(caps, id);
    if (st.state !== "ready") return { id, label, enabled: false, reason: st.reason };
    const why = fits(st.op);
    return { id, label, enabled: why === null, reason: why };
  };
  const tools = [
    choice("convert_image", "Convert", (op) => (allIn(op.inputs) ? null : `Needs ${labels(caps, op.inputs)} files only.`)),
    ...(operationState(caps, "resize_image").state !== "missing" && kinds.some((k) => k && ["jpeg", "png", "webp"].includes(k.id))
      ? [choice("resize_image", "Resize", (op) => (allIn(op.inputs) ? null : `Needs ${labels(caps, op.inputs)} pictures only.`))]
      : []),
    choice("compress", "Compress", () => null),
    choice("extract", "Extract", (op) => (allIn(op.inputs) ? null : `Needs ${labels(caps, op.inputs)} archives only.`)),
  ];
  // Pictures can become a PDF, documents can become a PDF; both are listed only when they apply to the selection.
  const have = (id: string) => operationState(caps, id).state !== "missing";
  if (have("images_to_pdf") && kinds.some((k) => k && ["jpeg", "png", "webp"].includes(k.id))) {
    tools.push(choice("images_to_pdf", "Images to PDF", (op) => (allIn(op.inputs) ? null : `Needs ${labels(caps, op.inputs)} pictures only.`)));
  }
  if (have("office_to_pdf") && kinds.some((k) => k && operationState(caps, "office_to_pdf").state !== "missing" && caps.operations.find((o) => o.id === "office_to_pdf")?.inputs.includes(k.id))) {
    tools.push(choice("office_to_pdf", "Convert to PDF", (op) => (allIn(op.inputs) ? null : "Needs Word, Excel, PowerPoint or OpenDocument files only.")));
  }
  // PDF tools are only listed once a PDF is selected (they mean nothing for other files), and only if
  // this build has them at all; an engine that is present but broken still says why.
  if (kinds.some((k) => k?.id === "pdf")) {
    const pdfs = files.length;
    if (have("pdf_view")) tools.push(choice("pdf_view", "Open PDF", (op) => (pdfs === 1 && allIn(op.inputs) ? null : "Choose one PDF to open it.")));
    if (have("pdf_merge")) tools.push(choice("pdf_merge", "Merge PDFs", (op) => (pdfs >= 2 && allIn(op.inputs) ? null : "Needs at least two PDFs, and nothing else.")));
    if (have("pdf_split")) tools.push(choice("pdf_split", "Split PDF", (op) => (pdfs === 1 && allIn(op.inputs) ? null : "Needs exactly one PDF.")));
    if (have("pdf_to_images")) tools.push(choice("pdf_to_images", "Save as images", (op) => (allIn(op.inputs) ? null : "Needs PDFs only.")));
  }
  return tools;
}

/** Short label of what the app handles, e.g. "JPG, PNG, WEBP, ZIP" (only formats an available operation uses). */
export function supportedSummary(caps: Capabilities): string {
  const used = new Set(caps.operations.filter((o) => o.available).flatMap((o) => [...o.inputs, ...o.outputs]));
  return caps.formats.filter((f) => used.has(f.id)).map((f) => f.label).join(", ");
}
