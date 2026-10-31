import { ArrowDown, ArrowUp, FileOutput, Highlighter, ImagePlus, MessageSquare, PenLine, Pencil, RotateCcw, RotateCw, Shapes, Strikethrough, Trash2, Type, Underline, type LucideIcon } from "lucide-react";
import { operationState } from "../../lib/capabilities";
import type { PdfDocumentResponse } from "../../lib/types";
import { useCapabilities } from "../../state/CapabilitiesProvider";
import { Callout, cx } from "../../components/ui";
import { DocumentDetails } from "./DocumentDetails";

export interface ToolAction {
  run: () => void;
  /** Why it can't be used at the moment (nothing selected, no PDF open…). */
  unavailable?: string;
  /** A drawing tool that is currently picked. */
  active?: boolean;
}

interface ToolDef {
  key: string;
  /** Backend operation that must be available for this tool to work. */
  op: string;
  label: string;
  Icon: LucideIcon;
  note?: string;
}

const GROUPS: { title: string; tools: ToolDef[] }[] = [
  {
    title: "Pages",
    tools: [
      { key: "rotate-left", op: "pdf_rotate", label: "Rotate left", Icon: RotateCcw },
      { key: "rotate-right", op: "pdf_rotate", label: "Rotate right", Icon: RotateCw },
      { key: "move-earlier", op: "pdf_reorder", label: "Move earlier", Icon: ArrowUp },
      { key: "move-later", op: "pdf_reorder", label: "Move later", Icon: ArrowDown },
      { key: "delete", op: "pdf_delete_pages", label: "Delete", Icon: Trash2 },
      { key: "extract", op: "pdf_extract_pages", label: "Extract…", Icon: FileOutput },
    ],
  },
  {
    title: "Annotate",
    tools: [
      { key: "highlight", op: "pdf_annotate", label: "Highlight", Icon: Highlighter },
      { key: "underline", op: "pdf_annotate", label: "Underline", Icon: Underline },
      { key: "strikethrough", op: "pdf_annotate", label: "Strikethrough", Icon: Strikethrough },
      { key: "comment", op: "pdf_annotate", label: "Comment", Icon: MessageSquare },
      { key: "draw", op: "pdf_annotate", label: "Draw", Icon: Pencil },
      { key: "shapes", op: "pdf_annotate", label: "Shapes", Icon: Shapes },
      { key: "text-box", op: "pdf_annotate", label: "Text box", Icon: Type },
      { key: "image", op: "pdf_annotate", label: "Image", Icon: ImagePlus },
    ],
  },
  {
    title: "Sign",
    tools: [{ key: "visual-signature", op: "pdf_annotate", label: "Visual signature", Icon: PenLine, note: "A drawn picture on the page. Not a verified digital signature." }],
  },
];

/**
 * The right-hand panel. A tool is enabled only when its backend operation is available, the editor has an action for it and
 * it makes sense for the current document. Nothing is offered that can't work.
 */
export function ToolsPanel({ doc, actions }: { doc: PdfDocumentResponse | null; actions: Record<string, ToolAction> }) {
  const { caps } = useCapabilities();
  return (
    <aside aria-label="Tools" className="flex min-h-0 flex-col gap-4 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
      {doc && <DocumentDetails doc={doc} />}
      <h2 className="px-1 text-sm font-semibold text-slate-900 dark:text-slate-100">Tools</h2>
      {GROUPS.map((g) => (
        <section key={g.title} aria-label={g.title}>
          <h3 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400">{g.title}</h3>
          <div className="grid grid-cols-2 gap-1.5">
            {g.tools.map((t) => {
              const st = caps ? operationState(caps, t.op) : null;
              const action = actions[t.key];
              const off = st?.state !== "ready" || !action || !!action.unavailable;
              const why = st && st.state !== "ready" ? st.reason : !action ? "Not available in this version yet." : (action.unavailable ?? "");
              return (
                <button
                  key={t.key}
                  type="button"
                  aria-disabled={off || undefined}
                  aria-pressed={action?.active}
                  title={off ? `${why}${t.note ? ` ${t.note}` : ""}` : (t.note ?? t.label)}
                  onClick={() => !off && action?.run()}
                  className={cx(
                    "flex min-h-10 items-center gap-2 rounded-lg border px-2.5 text-left text-xs font-medium transition-colors",
                    off
                      ? "cursor-not-allowed border-slate-100 bg-slate-50 text-slate-400 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-600"
                      : "border-slate-200 text-slate-800 hover:border-brand-300 hover:bg-brand-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-brand-900/20",
                    action?.active && !off && "border-brand-600 bg-brand-50 text-brand-900 dark:bg-brand-900/30 dark:text-brand-200",
                  )}
                >
                  <t.Icon className="size-4 shrink-0" aria-hidden />
                  <span>{t.label}</span>
                </button>
              );
            })}
          </div>
          {g.title === "Sign" && <p className="mt-2 px-1 text-xs text-slate-600 dark:text-slate-400">A drawn signature is only a picture on the page. It is not a verified digital signature.</p>}
        </section>
      ))}
      <Callout tone="warning" title="Before you save">
        <ul>
          <li>Saving always creates a new copy. Your original PDF is never changed.</li>
          <li>Editing or saving a signed PDF can make its existing digital signatures invalid.</li>
        </ul>
      </Callout>
    </aside>
  );
}
