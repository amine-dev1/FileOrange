import { Redo2, Trash2, Undo2 } from "lucide-react";
import { Segmented, cx } from "../../../components/ui";
import { useEditor } from "../../../state/EditorProvider";
import { COLORS, HIGHLIGHT_COLORS, MAX_WIDTH_PT } from "./model";
import type { ShapeChoice, ToolKey } from "./useAnnotations";
import { t } from "../../../lib/i18n";

const COLOR_NAMES: Record<string, string> = {
  "#FFEB3B": "Yellow",
  "#FF9800": "Orange",
  "#F44336": "Red",
  "#4CAF50": "Green",
  "#2196F3": "Blue",
  "#9C27B0": "Purple",
  "#000000": "Black",
  "#A5F3A0": "Mint",
  "#8FD3FF": "Sky blue",
  "#FFB3D1": "Pink",
  "#FFB74D": "Amber",
};

const TOOL_HELP: Record<ToolKey, string> = {
  highlight: "Drag over the text you want to highlight.",
  underline: "Drag over the text you want to underline.",
  strikethrough: "Drag over the text you want to strike through.",
  comment: "Click where the note goes, or drag to size it. Then type.",
  draw: "Press and drag to draw. Let go to finish a stroke.",
  shapes: "Drag on the page to draw the shape.",
  "text-box": "Click where the text goes, or drag to size the box. Then type.",
  image: "Click where the picture goes, or drag to size it.",
  "visual-signature": "Click where the signature goes, or drag to size it.",
};

function BarButton({ label, off, onClick, children }: { label: string; off: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} aria-disabled={off || undefined} onClick={() => !off && onClick()} className={cx("grid size-9 place-items-center rounded-lg", off ? "cursor-not-allowed text-slate-300 dark:text-slate-700" : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800")}>
      {children}
    </button>
  );
}

/** Undo/redo, and the colour, width, size and shape of what is being drawn or what is selected. */
export function AnnotationBar({ enabled }: { enabled: boolean }) {
  const { annotations: A } = useEditor();
  const selected = A.list.find((a) => a.id === A.selectedId) ?? null;
  const tool = A.tool;
  const subject = selected ? selected.kind : tool;
  const isText = selected ? selected.kind === "text" : tool === "text-box" || tool === "comment";
  const isLine = selected ? selected.kind === "ink" || selected.kind === "shape" : tool === "draw" || tool === "shapes";
  const colored = !!subject && subject !== "image" && !(selected?.kind === "ink" && selected.signature) && !(selected?.kind === "text" && !!selected.background);
  const palette = (selected ? selected.kind === "highlight" : tool === "highlight") ? HIGHLIGHT_COLORS : COLORS;
  const currentColor = selected && selected.kind !== "image" ? ("color" in selected ? selected.color : A.options.color) : A.options.color;
  const width = selected && (selected.kind === "ink" || selected.kind === "shape") ? selected.width : A.options.width;
  const size = selected && selected.kind === "text" ? selected.size : A.options.size;

  const pickColor = (c: string) => {
    A.setOptions({ color: c });
    if (!selected) return;
    A.update(
      selected.id,
      (a) => {
        if (a.kind === "shape") return { ...a, color: c, fill: a.fill ? c : null };
        if (a.kind === "image") return a;
        return { ...a, color: c };
      },
      true,
    );
  };
  const pickWidth = (w: number) => {
    A.setOptions({ width: w });
    if (selected && (selected.kind === "ink" || selected.kind === "shape")) A.update(selected.id, (a) => (a.kind === "ink" || a.kind === "shape" ? { ...a, width: w } : a), true);
  };
  const pickSize = (s: number) => {
    A.setOptions({ size: s });
    if (selected && selected.kind === "text") A.update(selected.id, (a) => (a.kind === "text" ? { ...a, size: s } : a), true);
  };

  const off = !enabled;
  return (
    <div role="toolbar" aria-label={t("Annotation tools")} data-testid="annotation-bar" className="flex min-h-[4.25rem] flex-wrap content-center items-center gap-x-5 gap-y-1.5 border-b border-slate-200 px-3 py-2 text-xs text-slate-600 dark:border-slate-800 dark:text-slate-400">
      <span className="flex items-center gap-0.5">
        <BarButton label={t("Undo")} off={off || !A.canUndo} onClick={A.undo}>
          <Undo2 className="size-4.5" aria-hidden />
        </BarButton>
        <BarButton label={t("Redo")} off={off || !A.canRedo} onClick={A.redo}>
          <Redo2 className="size-4.5" aria-hidden />
        </BarButton>
        <BarButton label={t("Delete selected annotation")} off={off || !selected} onClick={() => selected && A.remove(selected.id)}>
          <Trash2 className="size-4.5" aria-hidden />
        </BarButton>
      </span>
      {tool === "shapes" && (
        <Segmented<ShapeChoice>
          label={t("Shape")}
          value={A.options.shape}
          onChange={(shape) => A.setOptions({ shape })}
          options={[
            { value: "rect", label: "Rectangle" },
            { value: "ellipse", label: "Ellipse" },
            { value: "line", label: "Line" },
            { value: "arrow", label: "Arrow" },
          ]}
        />
      )}
      {tool === "shapes" && (A.options.shape === "rect" || A.options.shape === "ellipse") && (
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={A.options.filled} onChange={(e) => A.setOptions({ filled: e.target.checked })} className="accent-brand-600" /> {t("Filled")}
        </label>
      )}
      {colored && (
        <span role="radiogroup" aria-label={t("Colour")} className="flex items-center gap-1.5">
          {palette.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={c.toLowerCase() === currentColor.toLowerCase()}
              aria-label={t(COLOR_NAMES[c] ?? c)}
              title={t(COLOR_NAMES[c] ?? c)}
              onClick={() => pickColor(c)}
              style={{ background: c }}
              className="size-6 rounded-full border-2 border-white shadow ring-1 ring-slate-300 aria-checked:ring-2 aria-checked:ring-brand-600 dark:border-slate-900 dark:ring-slate-600"
            />
          ))}
        </span>
      )}
      {isLine && (
        <label className="flex items-center gap-2">
          {t("Width")}
          <input type="range" min={1} max={12} value={Math.min(width, MAX_WIDTH_PT)} onChange={(e) => pickWidth(Number(e.target.value))} aria-label={t("Line width")} className="w-24 accent-brand-600" />
          <output className="w-9 tabular-nums text-slate-800 dark:text-slate-200">{width}{t("pt")}</output>
        </label>
      )}
      {isText && (
        <label className="flex items-center gap-2">
          {t("Size")}
          <input type="range" min={8} max={48} value={size} onChange={(e) => pickSize(Number(e.target.value))} aria-label={t("Text size")} className="w-24 accent-brand-600" />
          <output className="w-9 tabular-nums text-slate-800 dark:text-slate-200">{size}{t("pt")}</output>
        </label>
      )}
      <span role="status" className="min-w-0 flex-1 basis-56">
        {t(tool === "image" && !A.pending ? "Choose a picture first." : tool ? TOOL_HELP[tool] : selected ? "Drag to move, use the corners to resize, Delete to remove. Double-click text to edit it." : "Choose a tool on the right, or click an annotation to select it.")}
      </span>
    </div>
  );
}
