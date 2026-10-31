import { Callout } from "../../components/Callout";
import { useCapabilities } from "../../app/CapabilitiesProvider";
import type { PdfDocument } from "../../lib/types";
import { PdfDocumentDetails } from "./PdfDocumentDetails";
import { EDITOR_TOOL_GROUPS } from "./pdfTools";
import { PDF_WARNINGS, pdfTaskState } from "./tasks";

/** What a button does right now. A tool with no entry has no action in this version of the editor. */
export interface ToolAction {
  run: () => void;
  /** Why it can't be used at the moment (nothing selected, no PDF open…). */
  unavailable?: string;
  /** The tool is switched on (a drawing tool that is currently picked). */
  active?: boolean;
}

/**
 * The right-hand panel. A tool is enabled only when its backend operation is available, the editor has an action
 * for it, and it makes sense for the current document.
 */
export function PdfToolsPanel({ doc, actions }: { doc: PdfDocument | null; actions: Record<string, ToolAction> }) {
  const { caps } = useCapabilities();
  return (
    <aside className="editor__tools" aria-label="Tools">
      {doc && <PdfDocumentDetails doc={doc} />}
      <h2 className="editor__panel-title">Tools</h2>
      {EDITOR_TOOL_GROUPS.map((g) => (
        <section key={g.title} className="tool-group" aria-label={g.title}>
          <h3>{g.title}</h3>
          <div className="tool-group__grid">
            {g.tools.map((t) => {
              const st = pdfTaskState(caps, t.opId);
              const action = actions[t.key];
              const off = !st.enabled || !action || !!action.unavailable;
              const why = !st.enabled ? (st.reason ?? "") : !action ? "Not available in this version yet." : (action.unavailable ?? "");
              return (
                <button key={t.key} className="tool" aria-disabled={off || undefined} aria-pressed={action?.active} title={off ? `${why}${t.note ? ` ${t.note}` : ""}` : (t.note ?? t.label)} onClick={() => !off && action?.run()}>
                  <t.Icon size={18} aria-hidden />
                  <span>{t.label}</span>
                </button>
              );
            })}
          </div>
          {g.title === "Sign" && <p className="tool-group__note">{PDF_WARNINGS.visualSignature}</p>}
          {g.title === "Forms" && <p className="tool-group__note">{PDF_WARNINGS.flatten}</p>}
        </section>
      ))}
      <Callout tone="warning" title="Before you save">
        <ul>
          <li>{PDF_WARNINGS.copy}</li>
          <li>{PDF_WARNINGS.signatures}</li>
        </ul>
      </Callout>
    </aside>
  );
}
