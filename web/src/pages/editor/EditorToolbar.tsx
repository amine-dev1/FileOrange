import { ChevronLeft, ChevronRight, Minus, Plus, ScanLine, StretchHorizontal, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { cx } from "../../components/ui";
import { useEditor } from "../../state/EditorProvider";
import { stepZoom } from "./zoom";
import { t } from "../../lib/i18n";

/** Page navigation and zoom controls above the preview. */
export function EditorToolbar({ enabled, pageCount, percent }: { enabled: boolean; pageCount: number; percent: number }) {
  const { page, setPage, zoom, setZoom } = useEditor();
  const [draft, setDraft] = useState<string | null>(null);

  const btn = (label: string, Icon: LucideIcon, act: () => void, extra?: { pressed?: boolean; off?: boolean }) => {
    const off = !enabled || extra?.off;
    return (
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-disabled={off || undefined}
        aria-pressed={extra?.pressed}
        onClick={() => !off && act()}
        className={cx("grid size-9 place-items-center rounded-lg", off ? "cursor-not-allowed text-slate-300 dark:text-slate-700" : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800", extra?.pressed && "bg-brand-100 text-brand-800 dark:bg-brand-900/30 dark:text-brand-300")}
      >
        <Icon className="size-4.5" aria-hidden />
      </button>
    );
  };

  const commit = () => {
    const n = Number.parseInt(draft ?? "", 10);
    if (Number.isFinite(n)) setPage(n);
    setDraft(null);
  };

  return (
    <div role="toolbar" aria-label={t("Page navigation and zoom")} className="flex flex-wrap items-center justify-center gap-x-6 gap-y-1 border-b border-slate-200 px-2 py-1.5 dark:border-slate-800">
      <span className="flex items-center gap-1">
        {btn("Previous page", ChevronLeft, () => setPage(page - 1), { off: page <= 1 })}
        <span className="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-400">
          <input
            aria-label={t("Page number")}
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
            className="h-8 w-12 rounded-md border border-slate-300 bg-white text-center tabular-nums disabled:bg-slate-100 dark:border-slate-700 dark:bg-slate-950 dark:disabled:bg-slate-900"
          />
          <span>{t("of")} {enabled ? pageCount : "–"}</span>
        </span>
        {btn("Next page", ChevronRight, () => setPage(page + 1), { off: page >= pageCount })}
      </span>
      <span className="flex items-center gap-1">
        {btn("Zoom out", Minus, () => setZoom(stepZoom(percent, -1)))}
        <output aria-label={t("Zoom level")} className="w-12 text-center text-sm tabular-nums text-slate-600 dark:text-slate-400">
          {enabled ? `${percent}%` : "—%"}
        </output>
        {btn("Zoom in", Plus, () => setZoom(stepZoom(percent, 1)))}
        {btn("Fit page width", StretchHorizontal, () => setZoom({ mode: "fit-width" }), { pressed: zoom.mode === "fit-width" })}
        {btn("Fit whole page", ScanLine, () => setZoom({ mode: "fit-page" }), { pressed: zoom.mode === "fit-page" })}
      </span>
    </div>
  );
}
