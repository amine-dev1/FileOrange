import { formatBytes, formatPdfDate } from "../../lib/format";
import type { PdfDocumentResponse } from "../../lib/types";
import { t } from "../../lib/i18n";

function protection(doc: PdfDocumentResponse): string | null {
  const { encrypted, permissions: p } = doc.info;
  if (!encrypted) return null;
  if (!p) return t("Password-protected");
  const asked = [!p.print && t("printing"), !p.copy && t("copying"), !p.modify && t("editing")].filter(Boolean);
  return asked.length ? t("Password-protected; the author asks to restrict {what}", { what: asked.join(", ") }) : t("Password-protected");
}

/** What the file says about itself, as the engine read it. */
export function DocumentDetails({ doc }: { doc: PdfDocumentResponse }) {
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
    ["Form fields", doc.info.has_form ? t("Yes") : null],
  ];
  return (
    <details className="rounded-xl border border-slate-200 text-sm dark:border-slate-800" aria-label={t("Document details")}>
      <summary className="cursor-pointer select-none px-3 py-2 font-semibold text-slate-900 dark:text-slate-100">{t("Document details")}</summary>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-slate-100 px-3 py-2 dark:border-slate-800">
        {rows
          .filter((r): r is [string, string] => !!r[1])
          .map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-slate-600 dark:text-slate-400">{t(k)}</dt>
              <dd className="break-words text-slate-800 dark:text-slate-200">{v}</dd>
            </div>
          ))}
      </dl>
    </details>
  );
}
