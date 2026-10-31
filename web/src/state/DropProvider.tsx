import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { itemsFromDrop, type FileItem } from "../lib/files";

type Handler = (items: FileItem[]) => void;
interface Ctx {
  register: (h: Handler | null) => void;
  dragging: boolean;
}
const DropContext = createContext<Ctx | null>(null);

/**
 * Files dropped anywhere on the page go to whichever screen is showing (its handler), so the whole window is a drop target.
 * Without a handler the page ignores drops, and the browser's own behaviour (opening the file) is prevented either way.
 */
export function DropProvider({ children }: { children: ReactNode }) {
  const handler = useRef<Handler | null>(null);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current++;
      if (handler.current) setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = handler.current ? "copy" : "none";
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      const h = handler.current;
      if (h && e.dataTransfer) void itemsFromDrop(e.dataTransfer).then((items) => items.length && h(items));
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);

  const register = useCallback((h: Handler | null) => void (handler.current = h), []);
  const value = useMemo(() => ({ register, dragging }), [register, dragging]);
  return (
    <DropContext.Provider value={value}>
      {children}
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-brand-600/15 backdrop-blur-[1px]" aria-hidden>
          <div className="rounded-2xl border-2 border-dashed border-brand-600 bg-white/90 px-8 py-6 text-lg font-semibold text-brand-800 shadow-xl dark:bg-slate-900/90 dark:text-brand-300">Drop to add</div>
        </div>
      )}
    </DropContext.Provider>
  );
}

/** Make this screen the target for dropped files. */
export function useOnDrop(handler: Handler | null) {
  const ctx = useContext(DropContext);
  if (!ctx) throw new Error("useOnDrop outside DropProvider");
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  const enabled = handler !== null;
  const { register } = ctx;
  useEffect(() => {
    if (!enabled) return;
    register((items) => latest.current?.(items));
    return () => register(null);
  }, [register, enabled]);
}

export const useDragging = () => useContext(DropContext)?.dragging ?? false;
