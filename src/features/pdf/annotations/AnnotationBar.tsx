import { Redo2, Trash2, Undo2 } from "lucide-react";
import { usePdf } from "../../../app/PdfProvider";
import { Segmented } from "../../../components/Fields";
import { COLORS, HIGHLIGHT_COLORS, MAX_WIDTH_PT } from "./model";
import type { ShapeChoice, ToolKey } from "./useAnnotations";

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

/** Undo/redo, and the colour, width, size and shape of what is being drawn or what is selected. */
export function AnnotationBar({ enabled }: { enabled: boolean }) {
  const { annotations: A } = usePdf();
  const selected = A.list.find((a) => a.id === A.selectedId) ?? null;
  const tool = A.tool;
  const subject = selected ? selected.kind : tool;
  const isText = selected ? selected.kind === "text" : tool === "text-box" || tool === "comment";
  const isLine = selected ? selected.kind === "ink" || selected.kind === "shape" : tool === "draw" || tool === "shapes";
  const colored = !!subject && subject !== "image" && !(selected?.kind === "ink" && selected.signature) && !(selected?.kind === "text" && !!selected.background);
  const palette = (selected ? selected.kind === "highlight" : tool === "highlight") ? HIGHLIGHT_COLORS : COLORS;
  const currentColor = selected ? (selected.kind === "text" || selected.kind === "ink" || selected.kind === "shape" || selected.kind === "highlight" || selected.kind === "underline" || selected.kind === "strike" ? selected.color : A.options.color) : A.options.color;
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
    <div className="annbar" role="toolbar" aria-label="Annotation tools" data-testid="annotation-bar">
      <span className="annbar__group">
        <button className="icon-btn" aria-label="Undo" title="Undo (Ctrl+Z)" aria-disabled={off || !A.canUndo || undefined} onClick={() => !off && A.canUndo && A.undo()}>
          <Undo2 size={18} aria-hidden />
        </button>
        <button className="icon-btn" aria-label="Redo" title="Redo (Ctrl+Y)" aria-disabled={off || !A.canRedo || undefined} onClick={() => !off && A.canRedo && A.redo()}>
          <Redo2 size={18} aria-hidden />
        </button>
        <button className="icon-btn" aria-label="Delete selected annotation" title="Delete (Del)" aria-disabled={off || !selected || undefined} onClick={() => !off && selected && A.remove(selected.id)}>
          <Trash2 size={18} aria-hidden />
        </button>
      </span>
      {tool === "shapes" && (
        <Segmented<ShapeChoice>
          label="Shape"
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
        <label className="annbar__check">
          <input type="checkbox" checked={A.options.filled} onChange={(e) => A.setOptions({ filled: e.target.checked })} /> Filled
        </label>
      )}
      {colored && (
        <span className="annbar__group" role="radiogroup" aria-label="Colour">
          {palette.map((c) => (
            <button key={c} role="radio" aria-checked={c.toLowerCase() === currentColor.toLowerCase()} aria-label={COLOR_NAMES[c] ?? c} title={COLOR_NAMES[c] ?? c} className="annbar__swatch" style={{ background: c }} onClick={() => pickColor(c)} />
          ))}
        </span>
      )}
      {isLine && (
        <label className="annbar__num">
          Width
          <input type="range" min={1} max={12} value={Math.min(width, MAX_WIDTH_PT)} onChange={(e) => pickWidth(Number(e.target.value))} aria-label="Line width" />
          <output>{width}pt</output>
        </label>
      )}
      {isText && (
        <label className="annbar__num">
          Size
          <input type="range" min={8} max={48} value={size} onChange={(e) => pickSize(Number(e.target.value))} aria-label="Text size" />
          <output>{size}pt</output>
        </label>
      )}
      <span className="annbar__hint" role="status">
        {tool === "image" && !A.pending ? "Choose a picture first." : tool ? TOOL_HELP[tool] : selected ? "Drag to move, use the corners to resize, Delete to remove. Double-click text to edit it." : "Choose a tool on the right, or click an annotation to select it."}
      </span>
    </div>
  );
}
