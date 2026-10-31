import { ChevronLeft, ChevronRight, Minus, Plus, ScanLine, StretchHorizontal } from "lucide-react";
import { useState } from "react";
import { usePdf } from "../../app/PdfProvider";
import { stepZoom } from "./zoom";

interface Props {
  enabled: boolean;
  reason: string;
  pageCount: number;
  /** Zoom as shown now, in percent. */
  percent: number;
}

/** Page navigation and zoom controls above the preview. */
export function EditorToolbar({ enabled, reason, pageCount, percent }: Props) {
  const { page, setPage, zoom, setZoom } = usePdf();
  const [draft, setDraft] = useState<string | null>(null);

  const btn = (label: string, Icon: typeof Plus, act: () => void, extra?: { pressed?: boolean; off?: boolean }) => {
    const off = !enabled || extra?.off;
    return (
      <button className="icon-btn" aria-label={label} aria-disabled={off || undefined} aria-pressed={extra?.pressed} title={!enabled ? reason : label} onClick={() => !off && act()}>
        <Icon size={18} aria-hidden />
      </button>
    );
  };

  const commit = () => {
    const n = Number.parseInt(draft ?? "", 10);
    if (Number.isFinite(n)) setPage(n);
    setDraft(null);
  };

  return (
    <div className="editor__toolbar" role="toolbar" aria-label="Page navigation and zoom">
      <span className="editor__toolbar-item">
        {btn("Previous page", ChevronLeft, () => setPage(page - 1), { off: page <= 1 })}
        <span className="editor__page-count">
          <input
            className="editor__page-input"
            aria-label="Page number"
            inputMode="numeric"
            disabled={!enabled}
            value={enabled ? (draft ?? String(page)) : "–"}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setDraft(e.target.value.replace(/\D/g, "").slice(0, 6))}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setDraft(null);
            }}
          />
          <span>of {enabled ? pageCount : "–"}</span>
        </span>
        {btn("Next page", ChevronRight, () => setPage(page + 1), { off: page >= pageCount })}
      </span>
      <span className="editor__toolbar-item">
        {btn("Zoom out", Minus, () => setZoom(stepZoom(percent, -1)))}
        <output className="editor__zoom" aria-label="Zoom level">
          {enabled ? `${percent}%` : "—%"}
        </output>
        {btn("Zoom in", Plus, () => setZoom(stepZoom(percent, 1)))}
        {btn("Fit page width", StretchHorizontal, () => setZoom({ mode: "fit-width" }), { pressed: zoom.mode === "fit-width" })}
        {btn("Fit whole page", ScanLine, () => setZoom({ mode: "fit-page" }), { pressed: zoom.mode === "fit-page" })}
      </span>
    </div>
  );
}
