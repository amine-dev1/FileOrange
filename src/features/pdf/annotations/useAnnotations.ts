import { useCallback, useMemo, useRef, useState } from "react";
import { pdfService } from "../../../services/pdfService";
import { basename } from "../../../lib/format";
import { commit, fresh, redo, replace, undo, MAX_HISTORY, type History, type UiAnnotation } from "./model";

export type ToolKey = "highlight" | "underline" | "strikethrough" | "comment" | "draw" | "shapes" | "text-box" | "image" | "visual-signature";
export type ShapeChoice = "rect" | "ellipse" | "line" | "arrow";

export interface ToolOptions {
  color: string;
  /** Pen and shape line width, in points. */
  width: number;
  /** Text size, in points. */
  size: number;
  shape: ShapeChoice;
  filled: boolean;
}

export const DEFAULT_OPTIONS: ToolOptions = { color: "#F44336", width: 2, size: 14, shape: "rect", filled: false };
/** Starting colour for each tool, so a highlighter is yellow and the pen is not. */
export const TOOL_COLOR: Partial<Record<ToolKey, string>> = { highlight: "#FFEB3B", underline: "#F44336", strikethrough: "#F44336", draw: "#2196F3", shapes: "#F44336", "text-box": "#000000", comment: "#000000" };
export const NOTE_COLOR = "#FFF2A8";
export const SIGNATURE_COLOR = "#1A237E";

export interface Picture {
  id: number;
  path: string;
  name: string;
  url: string;
  width: number;
  height: number;
}

/** A drawn signature waiting to be placed: strokes scaled to a unit box, plus the shape of that box. */
export interface PendingSignature {
  strokes: [number, number][][];
  /** Width divided by height. */
  aspect: number;
}

export type Pending = { kind: "picture"; picture: Picture } | { kind: "signature"; signature: PendingSignature } | null;

export interface AnnotationStore {
  list: UiAnnotation[];
  selectedId: number | null;
  select: (id: number | null) => void;
  tool: ToolKey | null;
  setTool: (t: ToolKey | null) => void;
  options: ToolOptions;
  setOptions: (patch: Partial<ToolOptions>) => void;
  pictures: Picture[];
  addPicture: (path: string) => Promise<Picture>;
  pending: Pending;
  setPending: (p: Pending) => void;
  add: (a: DistributiveOmit<UiAnnotation, "id">) => number;
  /** Change an annotation. With `step`, it can be undone as one step; without, it follows a `checkpoint()` (dragging). */
  update: (id: number, fn: (a: UiAnnotation) => UiAnnotation, step?: boolean) => void;
  /** Remember the current state as an undo step (the start of a drag). */
  checkpoint: () => void;
  remove: (id: number) => void;
  clear: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Forget everything: a different document was opened. */
  reset: () => void;
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** The annotations on the open PDF, with undo and redo. They are kept in memory and become part of the file only when a copy is saved. */
export function useAnnotations(): AnnotationStore {
  const [hist, setHist] = useState<History<UiAnnotation[]>>(() => fresh([]));
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [tool, setToolRaw] = useState<ToolKey | null>(null);
  const [options, setOptionsRaw] = useState<ToolOptions>(DEFAULT_OPTIONS);
  const [pictures, setPictures] = useState<Picture[]>([]);
  const [pending, setPending] = useState<Pending>(null);
  const nextId = useRef(1);
  const pictureUrls = useRef<string[]>([]);

  const setTool = useCallback((t: ToolKey | null) => {
    setToolRaw(t);
    setPending(null);
    if (t) {
      setSelectedId(null);
      const c = TOOL_COLOR[t];
      if (c) setOptionsRaw((o) => ({ ...o, color: c }));
    }
  }, []);

  const setOptions = useCallback((patch: Partial<ToolOptions>) => setOptionsRaw((o) => ({ ...o, ...patch })), []);

  const addPicture = useCallback(async (path: string): Promise<Picture> => {
    const blob = await pdfService.readPicture(path);
    const url = URL.createObjectURL(blob);
    try {
      const size = await new Promise<{ w: number; h: number }>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => reject(new Error("That picture couldn't be read."));
        img.src = url;
      });
      const pic: Picture = { id: nextId.current++, path, name: basename(path), url, width: size.w, height: size.h };
      pictureUrls.current.push(url);
      setPictures((p) => [...p, pic]);
      return pic;
    } catch (e) {
      URL.revokeObjectURL(url);
      throw e;
    }
  }, []);

  const add = useCallback((a: DistributiveOmit<UiAnnotation, "id">) => {
    const id = nextId.current++;
    setHist((h) => commit(h, [...h.present, { ...a, id } as UiAnnotation]));
    return id;
  }, []);

  const checkpoint = useCallback(() => setHist((h) => ({ past: [...h.past, h.present].slice(-MAX_HISTORY), present: h.present, future: [] })), []);

  const update = useCallback((id: number, fn: (a: UiAnnotation) => UiAnnotation, step = false) => {
    setHist((h) => {
      const next = h.present.map((a) => (a.id === id ? fn(a) : a));
      return step ? commit(h, next) : replace(h, next);
    });
  }, []);

  const remove = useCallback((id: number) => {
    setHist((h) => commit(h, h.present.filter((a) => a.id !== id)));
    setSelectedId((s) => (s === id ? null : s));
  }, []);

  const clear = useCallback(() => {
    setHist((h) => commit(h, []));
    setSelectedId(null);
  }, []);

  const doUndo = useCallback(() => {
    setHist((h) => undo(h));
    setSelectedId(null);
  }, []);
  const doRedo = useCallback(() => {
    setHist((h) => redo(h));
    setSelectedId(null);
  }, []);

  const reset = useCallback(() => {
    pictureUrls.current.forEach((u) => URL.revokeObjectURL(u));
    pictureUrls.current = [];
    setPictures([]);
    setHist(fresh([]));
    setSelectedId(null);
    setToolRaw(null);
    setPending(null);
    setOptionsRaw(DEFAULT_OPTIONS);
  }, []);

  return useMemo(
    () => ({ list: hist.present, selectedId, select: setSelectedId, tool, setTool, options, setOptions, pictures, addPicture, pending, setPending, add, update, checkpoint, remove, clear, undo: doUndo, redo: doRedo, canUndo: hist.past.length > 0, canRedo: hist.future.length > 0, reset }),
    [hist, selectedId, tool, setTool, options, setOptions, pictures, addPicture, pending, add, update, checkpoint, remove, clear, doUndo, doRedo, reset],
  );
}
