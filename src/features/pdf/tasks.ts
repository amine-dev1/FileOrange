import { ArrowDownUp, Combine, FileOutput, FileText, Highlighter, ImagePlus, Images, RotateCw, Split, type LucideIcon } from "lucide-react";
import type { Route } from "../../app/NavProvider";
import type { Capabilities } from "../../lib/types";
import { operationState } from "../../lib/capabilities";

/**
 * PDF tasks the app plans to offer, each tied to the backend operation id that
 * must exist (and be available) before it can be used. This list says what we
 * intend to build; it never says what works. The capability report does that.
 */
export interface PdfTask {
  opId: string;
  title: string;
  description: string;
  Icon: LucideIcon;
}

export const PDF_TASKS: PdfTask[] = [
  { opId: "pdf_merge", title: "Merge PDFs", description: "Combine several PDFs into one and choose the order.", Icon: Combine },
  { opId: "pdf_split", title: "Split PDF", description: "Split one PDF into several by page range.", Icon: Split },
  { opId: "pdf_reorder", title: "Reorder pages", description: "Drag pages into a new order and delete the ones you do not need.", Icon: ArrowDownUp },
  { opId: "pdf_rotate", title: "Rotate pages", description: "Turn selected pages by 90, 180 or 270 degrees.", Icon: RotateCw },
  { opId: "pdf_extract_pages", title: "Extract pages", description: "Save selected pages as a new PDF.", Icon: FileOutput },
  { opId: "pdf_to_images", title: "PDF pages to images", description: "Turn pages into PNG or JPG images with a resolution you choose.", Icon: Images },
  { opId: "images_to_pdf", title: "Images to PDF", description: "Put images on pages with the size, margins and order you choose.", Icon: ImagePlus },
  { opId: "office_to_pdf", title: "Documents to PDF", description: "Turn Word, Excel, PowerPoint and OpenDocument files into PDFs.", Icon: FileText },
  { opId: "pdf_annotate", title: "Annotate a PDF", description: "Highlight, draw, add notes, text, pictures and a visual signature.", Icon: Highlighter },
];

/** Workflow screens this build of the UI actually contains. An operation id is added here only together with its screen. */
export const IMPLEMENTED_PDF_WORKFLOWS = new Set<string>(["pdf_view", "pdf_merge", "pdf_split", "pdf_reorder", "pdf_rotate", "pdf_delete_pages", "pdf_extract_pages", "pdf_annotate", "pdf_to_images", "images_to_pdf", "office_to_pdf"]);

/** Where each task opens: its own screen, or the editor for tasks that work on pages of one open PDF. */
export const PDF_TASK_ROUTE: Record<string, Route> = { pdf_merge: "pdf-merge", pdf_split: "pdf-split", images_to_pdf: "images-to-pdf", pdf_to_images: "pdf-to-images", office_to_pdf: "office-to-pdf" };

export interface PdfTaskState {
  enabled: boolean;
  /** Short label for the card tag. */
  label: string | null;
  reason: string | null;
}

export function pdfTaskState(caps: Capabilities | null, opId: string): PdfTaskState {
  if (!caps) return { enabled: false, label: null, reason: "Checking what is available…" };
  const st = operationState(caps, opId);
  if (st.state === "missing") return { enabled: false, label: "Coming later", reason: "This needs a PDF engine, which is not part of this version yet." };
  if (st.state === "unavailable") return { enabled: false, label: "Unavailable", reason: st.reason };
  if (!IMPLEMENTED_PDF_WORKFLOWS.has(opId)) return { enabled: false, label: "Coming soon", reason: "The engine supports this; its screen is still being built." };
  return { enabled: true, label: null, reason: null };
}

/** Wording shown wherever a PDF change could have lasting effects. */
export const PDF_WARNINGS = {
  copy: "Saving always creates a new copy. Your original PDF is never changed.",
  flatten: "Flattening makes form fields and annotations a permanent part of the page. They can no longer be edited.",
  signatures: "Editing or saving a signed PDF can make its existing digital signatures invalid.",
  visualSignature: "A drawn signature is only a picture on the page. It is not a verified digital signature.",
} as const;
