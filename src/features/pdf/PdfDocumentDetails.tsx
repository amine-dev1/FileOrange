import { formatBytes, formatPdfDate } from "../../lib/format";
import type { PdfDocument } from "../../lib/types";

function protection(doc: PdfDocument): string | null {
  const { encrypted, permissions: p } = doc.info;
  if (!encrypted) return null;
  if (!p) return "Password-protected";
  const asked = [!p.print && "printing", !p.copy && "copying", !p.modify && "editing"].filter(Boolean);
  return asked.length ? `Password-protected; the author asks to restrict ${asked.join(", ")}` : "Password-protected";
}

/** What the file says about itself. Shown as the engine read it. */
export function PdfDocumentDetails({ doc }: { doc: PdfDocument }) {
  const m = doc.info.metadata;
  const rows: [string, string | null][] = [
    ["File", doc.name],
    ["Pages", String(doc.info.page_count)],
    ["Size", formatBytes(doc.size)],
    ["PDF version", doc.info.version],
    ["Title", m.title],
    ["Author", m.author],
    ["Subject", m.subject],
    ["Created with", m.creator],
    ["Produced by", m.producer],
    ["Created", m.created && formatPdfDate(m.created)],
    ["Modified", m.modified && formatPdfDate(m.modified)],
    ["Protection", protection(doc)],
    ["Digital signatures", doc.info.signature_count > 0 ? String(doc.info.signature_count) : null],
    ["Form fields", doc.info.has_form ? "Yes" : null],
  ];
  return (
    <section className="doc-details" aria-label="Document details">
      <h3>Document</h3>
      <dl>
        {rows
          .filter((r): r is [string, string] => !!r[1])
          .map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd className="selectable">{v}</dd>
            </div>
          ))}
      </dl>
    </section>
  );
}
