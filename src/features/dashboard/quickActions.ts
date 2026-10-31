import type { Capabilities } from "../../lib/types";
import { labels, operationState } from "../../lib/capabilities";

export interface QuickAction {
  route: "convert" | "pdf-editor" | "compress" | "extract";
  title: string;
  description: string;
  tag?: string;
}

/** What each PDF operation lets the user do, for the card text. Only operations the build reports are mentioned. */
const PDF_PHRASES: Record<string, string> = {
  pdf_view: "Preview",
  pdf_merge: "merge",
  pdf_split: "split",
  pdf_reorder: "reorder",
  pdf_rotate: "rotate",
  // Covered by the words above; listing every page operation would make the card read like a manual.
  pdf_delete_pages: "",
  pdf_extract_pages: "",
  pdf_annotate: "annotate",
  // These have their own cards on the PDF Tools page.
  pdf_to_images: "",
  images_to_pdf: "",
  office_to_pdf: "",
  pdf_fill_form: "fill forms in",
};

const list = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}` : (items[0] ?? ""));

/** The four dashboard cards. Descriptions name only what the capability report says exists. */
export function quickActions(caps: Capabilities | null): QuickAction[] {
  const convert = caps && operationState(caps, "convert_image");
  const extract = caps && operationState(caps, "extract");
  const compress = caps && operationState(caps, "compress");
  const pdfOps = caps ? caps.operations.filter((o) => o.id.startsWith("pdf_")) : [];
  const pdfReady = pdfOps.filter((o) => o.available);
  const off = (s: ReturnType<typeof operationState> | null) => (s && s.state !== "ready" ? s.reason : null);
  return [
    {
      route: "convert",
      title: "Convert files",
      description: off(convert) ?? (convert?.state === "ready" ? `Change between ${list(convert.op.inputs.map((i) => labels(caps!, [i])))} images.` : "Change between image formats."),
    },
    {
      route: "pdf-editor",
      title: "Edit PDF",
      description: pdfReady.length ? `${list(pdfReady.map((o) => PDF_PHRASES[o.id] ?? o.label.toLowerCase()).filter(Boolean))} PDF files.` : (pdfOps[0]?.unavailable_reason ?? "Merge, split, reorder and edit PDF files."),
      tag: pdfReady.length ? undefined : pdfOps.length ? "Unavailable" : "Coming later",
    },
    { route: "compress", title: "Compress files", description: off(compress) ?? "Reduce file size without losing quality." },
    {
      route: "extract",
      title: "Extract archive",
      description: off(extract) ?? (extract?.state === "ready" ? `Open ${list(extract.op.inputs.map((i) => labels(caps!, [i])))} archives.` : "Open archive files."),
    },
  ];
}
