import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { FileItem } from "../lib/files";

interface Ctx {
  items: FileItem[];
  add: (items: FileItem[]) => void;
  remove: (id: string) => void;
  clear: () => void;
  /** Move an item up (-1) or down (+1): order matters for merging and for pictures to PDF. */
  move: (id: string, delta: -1 | 1) => void;
  /** Replace the whole selection. */
  set: (items: FileItem[]) => void;
}

const SelectionContext = createContext<Ctx | null>(null);

const key = (f: FileItem) => `${f.relPath ?? f.name}|${f.size}|${f.file.lastModified}`;

/** The files the user has picked or dropped. Shared, so a selection made on the dashboard carries into the tool chosen next. */
export function SelectionProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<FileItem[]>([]);

  const add = useCallback((more: FileItem[]) => {
    setItems((prev) => {
      const seen = new Set(prev.map(key));
      const fresh = more.filter((f) => {
        const k = key(f);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      return fresh.length ? [...prev, ...fresh] : prev;
    });
  }, []);
  const remove = useCallback((id: string) => setItems((p) => p.filter((i) => i.id !== id)), []);
  const clear = useCallback(() => setItems([]), []);
  const set = useCallback((next: FileItem[]) => setItems(next), []);
  const move = useCallback((id: string, delta: -1 | 1) => {
    setItems((prev) => {
      const i = prev.findIndex((x) => x.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }, []);

  const value = useMemo(() => ({ items, add, remove, clear, move, set }), [items, add, remove, clear, move, set]);
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function useSelection(): Ctx {
  const c = useContext(SelectionContext);
  if (!c) throw new Error("useSelection outside SelectionProvider");
  return c;
}
