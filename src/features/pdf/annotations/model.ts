/**
 * The annotation model of the PDF editor: plain data and pure functions, no React. Annotations live in the
 * coordinates of the source page as the engine draws it (points, origin top-left, after the page's own
 * rotation), which is also what the backend expects. The editor shows them on top of the page picture and the
 * backend draws them into the saved copy.
 */
import type { Annotation, AnnotationRect } from "../../../lib/types";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What the editor adds to an annotation. `id` is stable while editing; `signature` only changes how it is listed. */
export type UiAnnotation = Annotation & { id: number; signature?: boolean };

/** Line height and first-line baseline, the same as the backend (`draw.rs`), so the screen matches the saved file. */
export const LINE_HEIGHT = 1.2;
export const BASELINE = 0.85;

export const COLORS = ["#FFEB3B", "#FF9800", "#F44336", "#4CAF50", "#2196F3", "#9C27B0", "#000000"];
export const HIGHLIGHT_COLORS = ["#FFEB3B", "#A5F3A0", "#8FD3FF", "#FFB3D1", "#FFB74D"];
export const MAX_WIDTH_PT = 200;

export const EMPTY_BOX: Box = { x: 0, y: 0, w: 0, h: 0 };

export function normalized(x0: number, y0: number, x1: number, y1: number): Box {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

const union = (boxes: Box[]): Box => {
  if (boxes.length === 0) return EMPTY_BOX;
  const l = Math.min(...boxes.map((b) => b.x));
  const t = Math.min(...boxes.map((b) => b.y));
  const r = Math.max(...boxes.map((b) => b.x + b.w));
  const b = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: l, y: t, w: r - l, h: b - t };
};

/** Height of `text` drawn at `size`, one line per `\n`. */
export const textHeight = (text: string, size: number): number => Math.max(1, text.split("\n").length) * size * LINE_HEIGHT;

export function bounds(a: UiAnnotation): Box {
  switch (a.kind) {
    case "highlight":
    case "underline":
    case "strike":
      return union(a.rects);
    case "ink": {
      const pts = a.strokes.flat();
      if (pts.length === 0) return EMPTY_BOX;
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const pad = a.width / 2;
      const l = Math.min(...xs) - pad;
      const t = Math.min(...ys) - pad;
      return { x: l, y: t, w: Math.max(...xs) + pad - l, h: Math.max(...ys) + pad - t };
    }
    case "shape": {
      const b = normalized(a.x0, a.y0, a.x1, a.y1);
      const pad = a.width / 2;
      return { x: b.x - pad, y: b.y - pad, w: b.w + a.width, h: b.h + a.width };
    }
    case "text":
      return { x: a.x, y: a.y, w: a.w ?? 160, h: a.h ?? textHeight(a.text, a.size) };
    case "image":
      return { x: a.x, y: a.y, w: a.w, h: a.h };
  }
}

const shiftRect = (r: AnnotationRect, dx: number, dy: number): AnnotationRect => ({ ...r, x: r.x + dx, y: r.y + dy });

export function moveBy<T extends Annotation>(a: T, dx: number, dy: number): T {
  switch (a.kind) {
    case "highlight":
    case "underline":
    case "strike":
      return { ...a, rects: a.rects.map((r) => shiftRect(r, dx, dy)) };
    case "ink":
      return { ...a, strokes: a.strokes.map((s) => s.map(([x, y]) => [x + dx, y + dy] as [number, number])) };
    case "shape":
      return { ...a, x0: a.x0 + dx, y0: a.y0 + dy, x1: a.x1 + dx, y1: a.y1 + dy };
    case "text":
    case "image":
      return { ...a, x: a.x + dx, y: a.y + dy };
  }
}

/** Stretch an annotation that sits in box `from` so that it fills box `to`. Text keeps its size; only its box changes. */
export function scaleTo<T extends Annotation>(a: T, from: Box, to: Box): T {
  const sx = from.w > 0 ? to.w / from.w : 1;
  const sy = from.h > 0 ? to.h / from.h : 1;
  const mx = (x: number) => to.x + (x - from.x) * sx;
  const my = (y: number) => to.y + (y - from.y) * sy;
  switch (a.kind) {
    case "highlight":
    case "underline":
    case "strike":
      return { ...a, rects: a.rects.map((r) => ({ x: mx(r.x), y: my(r.y), w: r.w * sx, h: r.h * sy })) };
    case "ink":
      return { ...a, strokes: a.strokes.map((s) => s.map(([x, y]) => [mx(x), my(y)] as [number, number])) };
    case "shape": {
      // The box includes half a line width all round; scale the geometry inside it.
      const pad = a.width / 2;
      const inner = { x: from.x + pad, y: from.y + pad, w: Math.max(0.0001, from.w - a.width), h: Math.max(0.0001, from.h - a.width) };
      const target = { x: to.x + pad, y: to.y + pad, w: Math.max(0, to.w - a.width), h: Math.max(0, to.h - a.width) };
      const ix = (x: number) => target.x + (x - inner.x) * (target.w / inner.w);
      const iy = (y: number) => target.y + (y - inner.y) * (target.h / inner.h);
      return { ...a, x0: ix(a.x0), y0: iy(a.y0), x1: ix(a.x1), y1: iy(a.y1) };
    }
    case "text":
      return { ...a, x: to.x, y: to.y, w: to.w, h: a.background ? to.h : (a.h ?? null) };
    case "image":
      return { ...a, x: to.x, y: to.y, w: to.w, h: to.h };
  }
}

const dist2Segment = (px: number, py: number, ax: number, ay: number, bx: number, by: number): number => {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return (px - cx) ** 2 + (py - cy) ** 2;
};

const inside = (b: Box, x: number, y: number, tol: number) => x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol;

/** Is the point (x, y) on this annotation, give or take `tol` points? Thin things (lines, pen strokes) are hit along their length. */
export function hits(a: UiAnnotation, x: number, y: number, tol: number): boolean {
  switch (a.kind) {
    case "highlight":
    case "underline":
    case "strike":
      return a.rects.some((r) => inside(r, x, y, tol));
    case "ink": {
      const reach = a.width / 2 + tol;
      return a.strokes.some((s) => (s.length === 1 ? (x - s[0][0]) ** 2 + (y - s[0][1]) ** 2 <= reach ** 2 : s.some((p, i) => i > 0 && dist2Segment(x, y, s[i - 1][0], s[i - 1][1], p[0], p[1]) <= reach ** 2)));
    }
    case "shape":
      if (a.shape === "line" || a.shape === "arrow") return dist2Segment(x, y, a.x0, a.y0, a.x1, a.y1) <= (a.width / 2 + tol) ** 2;
      return inside(bounds(a), x, y, tol);
    default:
      return inside(bounds(a), x, y, tol);
  }
}

/** The topmost annotation at a point (later ones are drawn on top). */
export function topmostAt(list: UiAnnotation[], page: number, x: number, y: number, tol: number): UiAnnotation | null {
  for (let i = list.length - 1; i >= 0; i--) if (list[i].page === page && hits(list[i], x, y, tol)) return list[i];
  return null;
}

// ---------------------------------------------------------------- text

/** Break `text` into lines no wider than `maxWidth` as `measure` sees them. Existing line breaks are kept; words longer than a line are cut. */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (para === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(/(?<= )/)) {
      const candidate = line + word;
      if (line === "" || measure(candidate.trimEnd()) <= maxWidth) {
        line = candidate;
        continue;
      }
      out.push(line.trimEnd());
      line = word;
    }
    // A single word wider than the box is cut between characters.
    let rest = line;
    while (rest.length > 1 && measure(rest.trimEnd()) > maxWidth) {
      let n = rest.length - 1;
      while (n > 1 && measure(rest.slice(0, n)) > maxWidth) n--;
      out.push(rest.slice(0, n));
      rest = rest.slice(n);
    }
    out.push(rest.trimEnd());
  }
  return out.join("\n");
}

/** True if the built-in PDF font can draw every character: Latin text, accents and common punctuation. Mirrors the backend's `drawable`. */
export function drawable(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (ch === "\n" || ch === "\t") continue;
    if (c < 0x20) return false;
    if (c < 0x7f || (c >= 0xa0 && c <= 0xff)) continue;
    if ("€‘’“”•–—…™ŠšŽžŒœŸ".includes(ch)) continue;
    return false;
  }
  return true;
}

// ---------------------------------------------------------------- saving

/** Annotations as the backend wants them: only for pages that are kept, without editor fields, text already wrapped, pictures numbered. */
export function toWire(list: UiAnnotation[], keepPages: ReadonlySet<number>, pictureIndex: ReadonlyMap<number, number>, measure: (text: string, size: number) => number): Annotation[] {
  const out: Annotation[] = [];
  for (const item of list) {
    if (!keepPages.has(item.page)) continue;
    // Drop editor-only fields.
    const { id: _id, signature: _sig, ...a } = item;
    void _id;
    void _sig;
    if (a.kind === "text") {
      if (a.text.trim() === "") continue;
      const w = a.w ?? 160;
      const wrapped = wrapText(a.text, Math.max(8, w - 8) * 0.98, (s) => measure(s, a.size));
      out.push({ ...a, text: wrapped, w, h: a.background ? (a.h ?? textHeight(wrapped, a.size) + 8) : null });
    } else if (a.kind === "image") {
      const idx = pictureIndex.get(a.image);
      if (idx === undefined) continue;
      out.push({ ...a, image: idx });
    } else {
      out.push(a as Annotation);
    }
  }
  return out;
}

/** Picture ids used by annotations on kept pages, in first-use order. Their position here is the file index sent with the job. */
export function usedPictures(list: UiAnnotation[], keepPages: ReadonlySet<number>): number[] {
  const seen: number[] = [];
  for (const a of list) if (a.kind === "image" && keepPages.has(a.page) && !seen.includes(a.image)) seen.push(a.image);
  return seen;
}

// ---------------------------------------------------------------- history

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
}

export const MAX_HISTORY = 200;

export const fresh = <T>(present: T): History<T> => ({ past: [], present, future: [] });

/** Record `next` as a new state; the old one can be undone. */
export function commit<T>(h: History<T>, next: T): History<T> {
  if (next === h.present) return h;
  return { past: [...h.past, h.present].slice(-MAX_HISTORY), present: next, future: [] };
}

/** Change the present state without making an undo step (used while dragging; the step is recorded when the drag starts). */
export const replace = <T>(h: History<T>, next: T): History<T> => ({ ...h, present: next });

export function undo<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h;
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] };
}

export function redo<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h;
  return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) };
}

// ---------------------------------------------------------------- drawing helpers

/** Drop pen points that are closer than `min` points to the previous one, always keeping the last. */
export function thin(points: [number, number][], min = 0.6): [number, number][] {
  if (points.length <= 2) return points;
  const out: [number, number][] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const [lx, ly] = out[out.length - 1];
    if ((points[i][0] - lx) ** 2 + (points[i][1] - ly) ** 2 >= min * min) out.push(points[i]);
  }
  out.push(points[points.length - 1]);
  return out;
}

/** Arrow-head wing points for the line (x0,y0)->(x1,y1); identical to the backend's so the preview matches. */
export function arrowHead(x0: number, y0: number, x1: number, y1: number, width: number): [[number, number], [number, number]] | null {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len <= 0.01) return null;
  const head = Math.min(Math.max(width * 4, 9), len * 0.5);
  const ang = Math.atan2(dy, dx);
  const wing = (s: number): [number, number] => [x1 - head * Math.cos(ang + s), y1 - head * Math.sin(ang + s)];
  return [wing(0.5), wing(-0.5)];
}
