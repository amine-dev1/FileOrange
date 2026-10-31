import { call } from "../lib/tauri";
import type { PdfDocument } from "../lib/types";

/** Opening and drawing PDFs. The files stay in Rust; the UI only gets descriptions and page images. */
export const pdfService = {
  open: (path: string, password?: string) => call<PdfDocument>("pdf_open", { path, password: password ?? null }),

  /** One page (from 1) drawn about `width` pixels wide, as PNG data. */
  async pageImage(documentId: string, page: number, width: number): Promise<Blob> {
    const data = await call<ArrayBuffer>("pdf_page_image", { documentId, page, width });
    return new Blob([data], { type: "image/png" });
  },

  /** A picture file's bytes, to show it before it is placed on a page. Rust checks that it really is a JPG, PNG or WebP. */
  async readPicture(path: string): Promise<Blob> {
    const data = await call<ArrayBuffer>("read_picture", { path });
    return new Blob([data]);
  },

  close: (documentId: string) => call<void>("pdf_close", { documentId }),
};
