import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePdf } from "../../../app/PdfProvider";
import type { PdfPageInfo, ShapeKind } from "../../../lib/types";
import type { Rotation } from "../plan";
import { FONT_FAMILY, measureText } from "./measure";
import { arrowHead, bounds, moveBy, normalized, scaleTo, textHeight, thin, topmostAt, wrapText, BASELINE, LINE_HEIGHT, type Box, type UiAnnotation } from "./model";
import { NOTE_COLOR, SIGNATURE_COLOR } from "./useAnnotations";

type Pt = { x: number; y: number };
type Corner = "nw" | "ne" | "sw" | "se";

type Gesture =
  | { kind: "rect"; start: Pt; cur: Pt }
  | { kind: "ink"; points: [number, number][] }
  | { kind: "move"; id: number; last: Pt; moved: boolean }
  | { kind: "resize"; id: number; corner: Corner; from: Box; original: UiAnnotation; checkpointed: boolean };

const CURSOR_TOOLS = new Set(["highlight", "underline", "strikethrough", "comment", "draw", "shapes", "text-box"]);
const DEFAULT_TEXT_W = 200;
const DEFAULT_NOTE = { w: 170, h: 90 };
const MIN_SIZE = 3;
/** Pixels on screen that count as "on" a thin thing, and the size of resize handles. */
const TOL_PX = 6;
const HANDLE_PX = 10;

/**
 * The annotations of one page, drawn over its picture and editable. The layer has the page's own shape (before any
 * turning the user added) and is turned with the picture, so coordinates stay in the page's own space whatever the
 * view looks like. Positions come from the browser's own screen-to-SVG transform, which handles the turning.
 */
export function AnnotationLayer({ srcPage, info, rot, interactive }: { srcPage: number; info: PdfPageInfo; rot: Rotation; interactive: boolean }) {
  const { annotations: A } = usePdf();
  const svgRef = useRef<SVGSVGElement>(null);
  const [k, setK] = useState(1); // CSS pixels per point
  // A gesture belongs to the tool it started under; picking another tool abandons it.
  const [started, setStarted] = useState<{ tool: string | null; g: Gesture } | null>(null);
  const gesture = started && started.tool === A.tool ? started.g : null;
  const setGesture = (g: Gesture | null) => setStarted(g ? { tool: A.tool, g } : null);
  const [editing, setEditing] = useState<number | null>(null);
  const W = info.width_pt;
  const H = info.height_pt;

  useLayoutEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const measure = () => setK((el.getBoundingClientRect().width || W) / W);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [W]);

  const items = useMemo(() => A.list.filter((a) => a.page === srcPage), [A.list, srcPage]);
  const selected = items.find((a) => a.id === A.selectedId) ?? null;
  const tol = TOL_PX / k;
  const handle = HANDLE_PX / k;

  const toPoint = (e: { clientX: number; clientY: number }): Pt => {
    const svg = svgRef.current!;
    const m = svg.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: Math.min(W, Math.max(0, p.x)), y: Math.min(H, Math.max(0, p.y)) };
  };

  const finishRect = (g: Extract<Gesture, { kind: "rect" }>) => {
    const box = normalized(g.start.x, g.start.y, g.cur.x, g.cur.y);
    const tool = A.tool;
    const o = A.options;
    const big = box.w >= MIN_SIZE && box.h >= MIN_SIZE;
    if (tool === "highlight" || tool === "underline" || tool === "strikethrough") {
      if (!big) return;
      const kind = tool === "strikethrough" ? "strike" : tool;
      A.add({ kind, page: srcPage, rects: [box], color: o.color });
      return;
    }
    if (tool === "shapes") {
      const long = Math.hypot(box.w, box.h) >= MIN_SIZE;
      if (!long) return;
      const filled = o.filled && (o.shape === "rect" || o.shape === "ellipse");
      A.add({ kind: "shape", page: srcPage, shape: o.shape as ShapeKind, x0: g.start.x, y0: g.start.y, x1: g.cur.x, y1: g.cur.y, color: o.color, width: o.width, fill: filled ? o.color : null });
      return;
    }
    if (tool === "text-box" || tool === "comment") {
      const note = tool === "comment";
      const w = big ? box.w : note ? DEFAULT_NOTE.w : DEFAULT_TEXT_W;
      const h = big ? box.h : note ? DEFAULT_NOTE.h : textHeight("", o.size);
      const x = Math.min(box.x, W - Math.min(w, W));
      const y = Math.min(box.y, H - Math.min(h, H));
      const id = A.add({ kind: "text", page: srcPage, x, y, text: "", size: o.size, color: note ? "#000000" : o.color, background: note ? NOTE_COLOR : null, w, h: note ? h : null });
      A.select(id);
      A.setTool(null);
      setEditing(id);
      return;
    }
    if ((tool === "image" || tool === "visual-signature") && A.pending) {
      const aspect = A.pending.kind === "picture" ? A.pending.picture.width / A.pending.picture.height : A.pending.signature.aspect;
      const defaultW = Math.min(A.pending.kind === "signature" ? 180 : 200, W * 0.6);
      const w = box.w >= 12 ? box.w : defaultW;
      const h = w / aspect;
      const x = Math.min(box.x, Math.max(0, W - w));
      const y = Math.min(box.y, Math.max(0, H - h));
      if (A.pending.kind === "picture") {
        const id = A.add({ kind: "image", page: srcPage, x, y, w, h, image: A.pending.picture.id });
        A.select(id);
      } else {
        const { strokes } = A.pending.signature;
        const placed = strokes.map((s) => s.map(([px, py]) => [x + px * w, y + py * h] as [number, number]));
        const id = A.add({ kind: "ink", page: srcPage, strokes: placed, color: SIGNATURE_COLOR, width: Math.max(1.2, w / 110), signature: true });
        A.select(id);
      }
      A.setTool(null);
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!interactive || e.button !== 0 || editing !== null) return;
    // Take the keyboard focus ourselves, without letting the browser scroll the (large) layer into view under the pointer.
    e.preventDefault();
    svgRef.current?.focus({ preventScroll: true });
    const p = toPoint(e);
    const tool = A.tool;
    if (tool === null) {
      const hit = topmostAt(A.list, srcPage, p.x, p.y, tol);
      A.select(hit?.id ?? null);
      if (hit) {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        setGesture({ kind: "move", id: hit.id, last: p, moved: false });
      }
      return;
    }
    if ((tool === "image" || tool === "visual-signature") && !A.pending) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    if (tool === "draw") setGesture({ kind: "ink", points: [[p.x, p.y]] });
    else setGesture({ kind: "rect", start: p, cur: p });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!gesture) return;
    const p = toPoint(e);
    if (gesture.kind === "rect") setGesture({ ...gesture, cur: p });
    else if (gesture.kind === "ink") setGesture({ ...gesture, points: [...gesture.points, [p.x, p.y]] });
    else if (gesture.kind === "move") {
      const dx = p.x - gesture.last.x;
      const dy = p.y - gesture.last.y;
      if (!gesture.moved && Math.hypot(dx, dy) < 1 / k) return;
      if (!gesture.moved) A.checkpoint();
      A.update(gesture.id, (a) => clampInside(moveBy(a, dx, dy), W, H));
      setGesture({ ...gesture, last: p, moved: true });
    } else if (gesture.kind === "resize") {
      if (!gesture.checkpointed) {
        A.checkpoint();
        setGesture({ ...gesture, checkpointed: true });
      }
      const next = resizedBox(gesture, p, W, H);
      A.update(gesture.id, () => scaleTo(gesture.original, gesture.from, next));
    }
  };

  const onPointerUp = () => {
    const g = gesture;
    setGesture(null);
    if (!g) return;
    if (g.kind === "rect") finishRect(g);
    else if (g.kind === "ink") {
      const pts = thin(g.points);
      A.add({ kind: "ink", page: srcPage, strokes: [pts], color: A.options.color, width: A.options.width });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!interactive || editing !== null) return;
    if (e.key === "Escape") {
      if (gesture) setGesture(null);
      else if (A.tool) A.setTool(null);
      else A.select(null);
      e.preventDefault();
      return;
    }
    if (!selected) return;
    const step = e.shiftKey ? 10 : 1;
    const nudge = (dx: number, dy: number) => {
      A.update(selected.id, (a) => clampInside(moveBy(a, dx, dy), W, H), true);
      e.preventDefault();
    };
    if (e.key === "Delete" || e.key === "Backspace") {
      A.remove(selected.id);
      e.preventDefault();
    } else if (e.key === "ArrowLeft") nudge(-step, 0);
    else if (e.key === "ArrowRight") nudge(step, 0);
    else if (e.key === "ArrowUp") nudge(0, -step);
    else if (e.key === "ArrowDown") nudge(0, step);
    else if (e.key === "Enter" && selected.kind === "text") {
      setEditing(selected.id);
      e.preventDefault();
    }
  };

  const startResize = (e: React.PointerEvent, corner: Corner) => {
    if (!selected) return;
    e.stopPropagation();
    (svgRef.current as Element).setPointerCapture(e.pointerId);
    setGesture({ kind: "resize", id: selected.id, corner, from: bounds(selected), original: selected, checkpointed: false });
  };

  const cursor = !interactive ? undefined : A.tool === "image" || A.tool === "visual-signature" ? (A.pending ? "copy" : "not-allowed") : A.tool && CURSOR_TOOLS.has(A.tool) ? "crosshair" : "default";

  const wrapperStyle: React.CSSProperties =
    rot === 0
      ? { position: "absolute", inset: 0 }
      : { position: "absolute", left: "50%", top: "50%", width: rot % 180 !== 0 ? `${(W / H) * 100}%` : "100%", aspectRatio: `${W} / ${H}`, transform: `translate(-50%, -50%) rotate(${rot}deg)` };

  const editingItem = items.find((a) => a.id === editing && a.kind === "text") ?? null;

  return (
    <div style={{ ...wrapperStyle, pointerEvents: "none" }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height="100%"
        role="group"
        aria-label={`Annotations on page ${srcPage}`}
        tabIndex={interactive ? 0 : -1}
        style={{ position: "absolute", inset: 0, overflow: "hidden", touchAction: "none", cursor, pointerEvents: interactive ? "auto" : "none", outline: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setGesture(null)}
        onKeyDown={onKeyDown}
        onDoubleClick={(e) => {
          if (!interactive || A.tool) return;
          const p = toPoint(e);
          const hit = topmostAt(A.list, srcPage, p.x, p.y, tol);
          if (hit?.kind === "text") {
            A.select(hit.id);
            setEditing(hit.id);
          }
        }}
        data-testid="annotation-layer"
        data-page={srcPage}
      >
        {items.map((a) => (
          <Drawn key={a.id} a={a} hidden={a.id === editing} />
        ))}
        {gesture && <Preview g={gesture} tool={A.tool} options={A.options} pending={A.pending} />}
        {selected && !gesture?.kind.startsWith("ink") && editing === null && <Selection a={selected} handle={handle} onResize={startResize} />}
        {editingItem && editingItem.kind === "text" && (
          <TextEditor
            a={editingItem}
            onDone={(text) => {
              setEditing(null);
              if (text.trim() === "") A.remove(editingItem.id);
              else if (text !== editingItem.text) A.update(editingItem.id, (a) => (a.kind === "text" ? { ...a, text } : a), true);
            }}
            onSize={(h) => A.update(editingItem.id, (a) => (a.kind === "text" && !a.background ? { ...a, h } : a))}
          />
        )}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------- pieces

function clampInside<T extends UiAnnotation>(a: T, W: number, H: number): T {
  const b = bounds(a);
  const dx = b.x < 0 ? -b.x : b.x + b.w > W ? Math.min(0, W - (b.x + b.w)) : 0;
  const dy = b.y < 0 ? -b.y : b.y + b.h > H ? Math.min(0, H - (b.y + b.h)) : 0;
  return dx || dy ? moveBy(a, dx, dy) : a;
}

function resizedBox(g: Extract<Gesture, { kind: "resize" }>, p: Pt, W: number, H: number): Box {
  const { from, corner, original } = g;
  const fixedX = corner === "nw" || corner === "sw" ? from.x + from.w : from.x;
  const fixedY = corner === "nw" || corner === "ne" ? from.y + from.h : from.y;
  const px = Math.min(W, Math.max(0, p.x));
  const py = Math.min(H, Math.max(0, p.y));
  let box = normalized(fixedX, fixedY, px, py);
  if (original.kind === "image" || (original.kind === "ink" && original.signature)) {
    // Pictures and signatures keep their shape.
    const aspect = from.w / from.h;
    const w = Math.max(box.w, box.h * aspect, MIN_SIZE);
    const h = w / aspect;
    box = { x: px < fixedX ? fixedX - w : fixedX, y: py < fixedY ? fixedY - h : fixedY, w, h };
  } else {
    box = { ...box, w: Math.max(box.w, MIN_SIZE), h: Math.max(box.h, MIN_SIZE) };
  }
  return box;
}

function Lines({ a }: { a: Extract<UiAnnotation, { kind: "text" }> }) {
  const w = a.w ?? DEFAULT_TEXT_W;
  const wrapped = wrapText(a.text, Math.max(8, w - 8) * 0.98, (s) => measureText(s, a.size)).split("\n");
  const pad = a.background ? 4 : 0;
  return (
    <>
      {wrapped.map((line, i) =>
        line ? (
          <text key={i} x={a.x + pad} y={a.y + pad + a.size * BASELINE + i * a.size * LINE_HEIGHT} fontSize={a.size} fontFamily={FONT_FAMILY} fill={a.color} style={{ whiteSpace: "pre", userSelect: "none" }}>
            {line}
          </text>
        ) : null,
      )}
    </>
  );
}

function Drawn({ a, hidden }: { a: UiAnnotation; hidden: boolean }) {
  const { annotations: A } = usePdf();
  if (hidden) return null;
  switch (a.kind) {
    case "highlight":
      return (
        <g data-ann={a.id} data-kind="highlight">
          {a.rects.map((r, i) => (
            <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill={a.color} style={{ mixBlendMode: "multiply" }} />
          ))}
        </g>
      );
    case "underline":
    case "strike":
      return (
        <g data-ann={a.id} data-kind={a.kind}>
          {a.rects.map((r, i) => {
            const y = a.kind === "underline" ? r.y + r.h - r.h * 0.04 : r.y + r.h * 0.55;
            return <line key={i} x1={r.x} y1={y} x2={r.x + r.w} y2={y} stroke={a.color} strokeWidth={Math.max(r.h * 0.07, 0.8)} strokeLinecap="round" />;
          })}
        </g>
      );
    case "ink":
      return (
        <g data-ann={a.id} data-kind={a.signature ? "signature" : "ink"} fill="none" stroke={a.color} strokeWidth={a.width} strokeLinecap="round" strokeLinejoin="round">
          {a.strokes.map((s, i) => (s.length === 1 ? <circle key={i} cx={s[0][0]} cy={s[0][1]} r={a.width / 2} fill={a.color} stroke="none" /> : <polyline key={i} points={s.map((p) => p.join(",")).join(" ")} />))}
        </g>
      );
    case "shape": {
      const b = normalized(a.x0, a.y0, a.x1, a.y1);
      const common = { stroke: a.color, strokeWidth: a.width, strokeLinejoin: "round" as const, strokeLinecap: "round" as const, fill: a.fill ?? "none" };
      return (
        <g data-ann={a.id} data-kind={`shape-${a.shape}`}>
          {a.shape === "rect" && <rect x={b.x} y={b.y} width={b.w} height={b.h} {...common} />}
          {a.shape === "ellipse" && <ellipse cx={b.x + b.w / 2} cy={b.y + b.h / 2} rx={b.w / 2} ry={b.h / 2} {...common} />}
          {(a.shape === "line" || a.shape === "arrow") && <line x1={a.x0} y1={a.y0} x2={a.x1} y2={a.y1} {...common} fill="none" />}
          {a.shape === "arrow" &&
            (() => {
              const wings = arrowHead(a.x0, a.y0, a.x1, a.y1, a.width);
              return wings ? <polyline points={`${wings[0].join(",")} ${a.x1},${a.y1} ${wings[1].join(",")}`} {...common} fill="none" /> : null;
            })()}
        </g>
      );
    }
    case "text":
      return (
        <g data-ann={a.id} data-kind={a.background ? "note" : "text"}>
          {a.background && <rect x={a.x} y={a.y} width={a.w ?? DEFAULT_NOTE.w} height={a.h ?? DEFAULT_NOTE.h} fill={a.background} />}
          <Lines a={a} />
        </g>
      );
    case "image": {
      const pic = A.pictures.find((p) => p.id === a.image);
      return (
        <g data-ann={a.id} data-kind="image">
          {pic ? <image href={pic.url} x={a.x} y={a.y} width={a.w} height={a.h} preserveAspectRatio="none" /> : <rect x={a.x} y={a.y} width={a.w} height={a.h} fill="#eee" stroke="#999" />}
        </g>
      );
    }
  }
}

function Preview({ g, tool, options, pending }: { g: Gesture; tool: string | null; options: { color: string; width: number; shape: string; filled: boolean }; pending: unknown }) {
  if (g.kind === "ink") return <polyline points={g.points.map((p) => p.join(",")).join(" ")} fill="none" stroke={options.color} strokeWidth={options.width} strokeLinecap="round" strokeLinejoin="round" />;
  if (g.kind !== "rect") return null;
  const b = normalized(g.start.x, g.start.y, g.cur.x, g.cur.y);
  if (tool === "shapes" && (options.shape === "line" || options.shape === "arrow")) return <line x1={g.start.x} y1={g.start.y} x2={g.cur.x} y2={g.cur.y} stroke={options.color} strokeWidth={options.width} strokeLinecap="round" />;
  if (tool === "shapes" && options.shape === "ellipse") return <ellipse cx={b.x + b.w / 2} cy={b.y + b.h / 2} rx={b.w / 2} ry={b.h / 2} fill={options.filled ? options.color : "none"} stroke={options.color} strokeWidth={options.width} />;
  const fill = tool === "highlight" ? options.color : tool === "shapes" && options.filled ? options.color : "none";
  const dashed = tool === "text-box" || tool === "comment" || ((tool === "image" || tool === "visual-signature") && !!pending);
  return <rect x={b.x} y={b.y} width={b.w} height={b.h} fill={fill} fillOpacity={tool === "highlight" ? 0.5 : 1} stroke={dashed || tool === "shapes" ? options.color : "none"} strokeWidth={tool === "shapes" ? options.width : 1} strokeDasharray={dashed ? "4 3" : undefined} />;
}

function Selection({ a, handle, onResize }: { a: UiAnnotation; handle: number; onResize: (e: React.PointerEvent, c: Corner) => void }) {
  const b = bounds(a);
  const pad = handle / 3;
  const corners: [Corner, number, number, string][] = [
    ["nw", b.x - pad, b.y - pad, "nwse-resize"],
    ["ne", b.x + b.w + pad, b.y - pad, "nesw-resize"],
    ["sw", b.x - pad, b.y + b.h + pad, "nesw-resize"],
    ["se", b.x + b.w + pad, b.y + b.h + pad, "nwse-resize"],
  ];
  return (
    <g data-testid="selection" pointerEvents="none">
      <rect x={b.x - pad} y={b.y - pad} width={b.w + 2 * pad} height={b.h + 2 * pad} fill="none" stroke="#E8590C" strokeWidth={handle / 8} strokeDasharray={`${handle / 2} ${handle / 3}`} />
      {corners.map(([c, cx, cy, cursor]) => (
        <rect key={c} data-handle={c} x={cx - handle / 2} y={cy - handle / 2} width={handle} height={handle} rx={handle / 5} fill="#fff" stroke="#E8590C" strokeWidth={handle / 8} style={{ cursor, pointerEvents: "auto" }} onPointerDown={(e) => onResize(e, c)} />
      ))}
    </g>
  );
}

function TextEditor({ a, onDone, onSize }: { a: Extract<UiAnnotation, { kind: "text" }>; onDone: (text: string) => void; onSize: (h: number) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(a.text);
  const w = a.w ?? DEFAULT_TEXT_W;
  const h = Math.max(a.h ?? 0, textHeight(text, a.size) + 8);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  useEffect(() => {
    if (!a.background) onSize(textHeight(text, a.size));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text.split("\n").length]);
  return (
    <foreignObject x={a.x} y={a.y} width={w} height={h} onPointerDown={(e) => e.stopPropagation()}>
      <textarea
        ref={ref}
        aria-label="Text of the annotation"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => onDone(text)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
            e.preventDefault();
            onDone(text);
          }
        }}
        style={{ width: "100%", height: "100%", boxSizing: "border-box", padding: a.background ? 4 : 0, margin: 0, border: "1px dashed #E8590C", outline: "none", resize: "none", overflow: "hidden", background: a.background ?? "rgba(255,255,255,0.85)", color: a.color, font: `${a.size}px/${LINE_HEIGHT} ${FONT_FAMILY}` }}
      />
    </foreignObject>
  );
}

