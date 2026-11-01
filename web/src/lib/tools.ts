import { ArrowLeftRight, QrCode, FileDown, Lock, LockOpen, Minimize2, PenLine, FileArchive, FilePenLine, FileText, Images, ImagePlus, Layers, Scissors, Shrink, type LucideIcon } from "lucide-react";
import type { ToolId } from "./types";

export interface ToolDef {
  /** The backend operation id that must be available for this tool to work. */
  op: string;
  path: string;
  title: string;
  description: string;
  Icon: LucideIcon;
  group: "files" | "pdf";
  /** Used on the dashboard cards for the selected files. */
  short: string;
  tool?: ToolId;
  /** Runs entirely in the browser: always available, whatever the server can do. */
  local?: boolean;
}

export const TOOLS: ToolDef[] = [
  { op: "convert_image", path: "/convert", title: "Convert images", short: "Convert", description: "Change pictures between JPG, PNG and WebP.", Icon: ArrowLeftRight, group: "files", tool: "convert" },
  { op: "resize_image", path: "/resize", title: "Compress images", short: "Compress images", description: "Make pictures lighter: a smaller file size, smaller dimensions, or both.", Icon: Minimize2, group: "files", tool: "resize" },
  { op: "compress", path: "/compress", title: "Make a ZIP", short: "Make a ZIP", description: "Put files and folders into one ZIP archive.", Icon: Shrink, group: "files", tool: "compress" },
  { op: "extract", path: "/extract", title: "Extract a ZIP", short: "Extract", description: "Open a ZIP archive safely, with a password if it has one.", Icon: FileArchive, group: "files", tool: "extract" },
  { op: "qr", path: "/qr", title: "QR codes", short: "QR codes", description: "Make a QR code for a link, Wi-Fi or a contact, or read the text inside one.", Icon: QrCode, group: "files", local: true },
  { op: "pdf_view", path: "/pdf/editor", title: "PDF editor", short: "Open PDF", description: "View, reorder, rotate, delete and extract pages, and annotate.", Icon: FilePenLine, group: "pdf" },
  { op: "pdf_annotate", path: "/pdf/editor?sign=1", title: "Sign a PDF", short: "Sign", description: "Draw, type or upload your signature and place it on the page.", Icon: PenLine, group: "pdf" },
  { op: "pdf_compress", path: "/pdf/compress", title: "Compress PDF", short: "Compress PDF", description: "Make PDFs smaller by recompressing the pictures inside. Text stays sharp.", Icon: FileDown, group: "pdf", tool: "pdf-compress" },
  { op: "pdf_merge", path: "/pdf/merge", title: "Merge PDFs", short: "Merge PDFs", description: "Join several PDFs into one, in the order you choose.", Icon: Layers, group: "pdf", tool: "pdf-merge" },
  { op: "pdf_split", path: "/pdf/split", title: "Split a PDF", short: "Split PDF", description: "Cut one PDF into several, by pages or ranges.", Icon: Scissors, group: "pdf", tool: "pdf-split" },
  { op: "images_to_pdf", path: "/pdf/images-to-pdf", title: "Images to PDF", short: "Images to PDF", description: "Put pictures on PDF pages with the size and margins you choose.", Icon: ImagePlus, group: "pdf", tool: "images-to-pdf" },
  { op: "pdf_to_images", path: "/pdf/to-images", title: "PDF to images", short: "Save as images", description: "Save PDF pages as PNG, JPG or WebP at the resolution you choose.", Icon: Images, group: "pdf", tool: "pdf-to-images" },
  { op: "pdf_protect", path: "/pdf/protect", title: "Add a password", short: "Add password", description: "Protect a PDF so only people with the password can open it.", Icon: Lock, group: "pdf", tool: "pdf-protect" },
  { op: "pdf_unlock", path: "/pdf/unlock", title: "Remove a password", short: "Remove password", description: "Save an unprotected copy of a PDF whose password you know.", Icon: LockOpen, group: "pdf", tool: "pdf-unlock" },
  { op: "office_to_pdf", path: "/pdf/documents-to-pdf", title: "Documents to PDF", short: "Convert to PDF", description: "Turn Word, Excel, PowerPoint and OpenDocument files into PDFs.", Icon: FileText, group: "pdf", tool: "office-to-pdf" },
];

export const toolByOp = (op: string) => TOOLS.find((t) => t.op === op);
