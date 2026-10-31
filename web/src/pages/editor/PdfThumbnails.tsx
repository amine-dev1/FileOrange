import { ImageOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { messageOf } from "../../lib/errors";
import type { PdfDocumentResponse } from "../../lib/types";
import { useEditor } from "../../state/EditorProvider";
import { cx } from "../../components/ui";
import type { PageImages } from "./pageImages";
import { turned, type PlanPage } from "./plan";
import { RotatedPage } from "./RotatedPage";

/** Thumbnails are drawn about this wide: sharp at the strip's width on a high-density screen. */
const THUMB_WIDTH = 256;
/** How far the pointer must travel before a press becomes a drag. */
const DRAG_THRESHOLD = 6;

interface ThumbProps {
  entry: PlanPage;
  position: number;
  doc: PdfDocumentResponse;
  images: PageImages;
  current: boolean;
  selected: boolean;
  total: number;
  onPointerDown: (e: React.PointerEvent, entry: PlanPage, position: number) => void;
  onClick: (e: React.MouseEvent, position: number) => void;
}

function Thumb({ entry, position, doc, images, current, selected, total, onPointerDown, onClick }: ThumbProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const [near, setNear] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const source = doc.info.pages[entry.src - 1];
  const shape = turned(source, entry.rot);

  // Draw a thumbnail only once it is about to be seen: a 300-page file doesn't start 300 renders.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setNear(true), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    images
      .url(entry.src, THUMB_WIDTH)
      .then((u) => !cancelled && (setUrl(u), setError(null)))
      .catch((e) => !cancelled && setError(messageOf(e)));
    return () => {
      cancelled = true;
    };
  }, [near, images, entry.src, retry]);

  useEffect(() => {
    if (current) ref.current?.scrollIntoView({ block: "nearest" });
  }, [current, position]);

  return (
    <button
      ref={ref}
      type="button"
      aria-label={`Page ${position}`}
      aria-description={entry.src !== position ? `Originally page ${entry.src}` : undefined}
      aria-current={current ? "page" : undefined}
      aria-pressed={selected}
      data-position={position}
      tabIndex={current ? 0 : -1}
      onPointerDown={(e) => onPointerDown(e, entry, position)}
      onClick={(e) => (error ? setRetry((r) => r + 1) : onClick(e, position))}
      title={error ? `${error} Click to try again.` : `Page ${position} of ${total}. Click to show it; Ctrl or Shift to select several; drag to move.`}
      className={cx(
        "flex w-full touch-pan-y flex-col items-center gap-1 rounded-xl border-2 p-1.5 transition-colors",
        selected ? "border-brand-600 bg-brand-50 dark:bg-brand-900/20" : "border-transparent hover:bg-slate-100 dark:hover:bg-slate-800",
        current && !selected && "border-slate-300 dark:border-slate-600",
      )}
    >
      <span className="relative block w-full overflow-hidden rounded bg-white shadow ring-1 ring-slate-200 dark:ring-slate-700" style={{ aspectRatio: `${shape.width_pt} / ${shape.height_pt}` }}>
        {url ? <RotatedPage url={url} info={source} rot={entry.rot} alt="" /> : error ? <ImageOff className="absolute inset-0 m-auto size-5 text-slate-400" aria-hidden /> : <span className="skeleton absolute inset-0" aria-hidden />}
      </span>
      <span className="text-xs font-medium tabular-nums text-slate-600 dark:text-slate-400">
        {position}
        {entry.rot !== 0 && <span className="text-brand-700 dark:text-brand-300"> ↻{entry.rot}°</span>}
      </span>
    </button>
  );
}

/**
 * Page thumbnails down the side of the editor, in the order the new PDF will have. Click to show a page, Ctrl/Shift-click to
 * select several, drag to reorder; arrow keys move between pages (Shift extends the selection, Alt+arrow moves the selected
 * pages, Delete removes them).
 */
export function PdfThumbnails({ doc, images }: { doc: PdfDocumentResponse; images: PageImages }) {
  const { plan, page, selected, choose, selectAll, deleteSelected, moveSelected, moveBlock } = useEditor();
  const listRef = useRef<HTMLOListElement>(null);
  const refocus = useRef(false);
  const justDragged = useRef(false);
  const [drop, setDrop] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    listRef.current?.querySelector<HTMLButtonElement>(`[data-position="${page}"]`)?.focus();
  }, [page, plan]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      selectAll();
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      refocus.current = true; // the focused thumbnail is gone; keep the keyboard in the list
      deleteSelected();
      return;
    }
    const dir = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (dir && e.altKey) {
      e.preventDefault();
      refocus.current = true;
      moveSelected(dir as 1 | -1);
      return;
    }
    const target = e.key === "Home" ? 1 : e.key === "End" ? plan.length : page + dir;
    if (!dir && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    refocus.current = true;
    choose(Math.min(Math.max(1, target), plan.length), e.shiftKey ? "range" : "only");
  };

  const onClick = (e: React.MouseEvent, position: number) => {
    if (justDragged.current) {
      justDragged.current = false;
      return;
    }
    choose(position, e.shiftKey ? "range" : e.ctrlKey || e.metaKey ? "toggle" : "only");
  };

  // Dragging uses pointer events rather than HTML5 drag-and-drop, so it also works with touch and pens.
  const onPointerDown = (e: React.PointerEvent, entry: PlanPage, position: number) => {
    if (e.button !== 0 || e.pointerType === "touch") return;
    const list = listRef.current;
    if (!list) return;
    const startY = e.clientY;
    let active = false;
    const slots = () => [...list.querySelectorAll<HTMLElement>("[data-position]")];
    const insertionAt = (y: number) => {
      const els = slots();
      for (let i = 0; i < els.length; i++) {
        const r = els[i].getBoundingClientRect();
        if (y < r.top + r.height / 2) return i;
      }
      return els.length;
    };
    const move = (ev: PointerEvent) => {
      if (!active && Math.abs(ev.clientY - startY) < DRAG_THRESHOLD) return;
      if (!active) {
        active = true;
        setDragging(true);
        if (!selected.includes(entry.id)) choose(position, "only");
      }
      const box = list.getBoundingClientRect();
      if (ev.clientY < box.top + 28) list.scrollBy({ top: -14 });
      else if (ev.clientY > box.bottom - 28) list.scrollBy({ top: 14 });
      setDrop(insertionAt(ev.clientY));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (!active) return;
      justDragged.current = true;
      window.setTimeout(() => (justDragged.current = false), 0);
      const at = insertionAt(ev.clientY);
      setDrop(null);
      setDragging(false);
      moveBlock(selected.includes(entry.id) ? selected : [entry.id], at);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const selectedSet = new Set(selected);
  return (
    <aside aria-label="Page thumbnails" className="flex min-h-0 flex-col gap-2 rounded-2xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
      <h2 className="px-1 text-sm font-semibold text-slate-900 dark:text-slate-100">Pages</h2>
      <ol ref={listRef} onKeyDown={onKeyDown} className={cx("flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-0.5", dragging && "cursor-grabbing select-none")}>
        {plan.map((entry, i) => (
          <li key={entry.id} className={cx("relative", drop === i && "before:absolute before:-top-1 before:left-0 before:right-0 before:z-10 before:h-0.5 before:rounded before:bg-brand-600", drop === plan.length && i === plan.length - 1 && "after:absolute after:-bottom-1 after:left-0 after:right-0 after:z-10 after:h-0.5 after:rounded after:bg-brand-600")}>
            <Thumb entry={entry} position={i + 1} doc={doc} images={images} current={page === i + 1} selected={selectedSet.has(entry.id)} total={plan.length} onPointerDown={onPointerDown} onClick={onClick} />
          </li>
        ))}
      </ol>
    </aside>
  );
}
