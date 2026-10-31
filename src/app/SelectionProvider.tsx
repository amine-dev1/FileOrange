import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { PathInfo } from "../lib/types";
import { jobsService } from "../services/jobsService";
import { messageOf } from "../lib/tauri";
import { useToast } from "./ToastProvider";

interface Ctx {
  items: PathInfo[];
  busy: boolean;
  add: (paths: string[]) => Promise<void>;
  remove: (path: string) => void;
  clear: () => void;
  /** Move an item up (-1) or down (+1) in the list; order matters when merging. */
  move: (path: string, delta: -1 | 1) => void;
}

const SelectionContext = createContext<Ctx | null>(null);

/** The files the user has picked or dropped. Shared so a selection made on the
 *  dashboard carries into whichever workflow is chosen next. */
export function SelectionProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<PathInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const known = useRef(new Set<string>());
  const { push } = useToast();

  const add = useCallback(
    async (paths: string[]) => {
      const fresh = paths.filter((p) => !known.current.has(p));
      if (fresh.length === 0) return;
      fresh.forEach((p) => known.current.add(p));
      setBusy(true);
      try {
        const info = await jobsService.inspectPaths(fresh);
        setItems((prev) => [...prev, ...info]);
      } catch (e) {
        fresh.forEach((p) => known.current.delete(p));
        push("error", messageOf(e));
      } finally {
        setBusy(false);
      }
    },
    [push],
  );

  const remove = useCallback((path: string) => {
    known.current.delete(path);
    setItems((prev) => prev.filter((i) => i.path !== path));
  }, []);

  const clear = useCallback(() => {
    known.current.clear();
    setItems([]);
  }, []);

  const move = useCallback((path: string, delta: -1 | 1) => {
    setItems((prev) => {
      const i = prev.findIndex((x) => x.path === path);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }, []);

  const value = useMemo(() => ({ items, busy, add, remove, clear, move }), [items, busy, add, remove, clear, move]);
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function useSelection(): Ctx {
  const c = useContext(SelectionContext);
  if (!c) throw new Error("useSelection outside SelectionProvider");
  return c;
}
