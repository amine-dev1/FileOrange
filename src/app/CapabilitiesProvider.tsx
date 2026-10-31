import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Capabilities } from "../lib/types";
import { messageOf } from "../lib/tauri";
import { jobsService } from "../services/jobsService";

type State = { status: "loading" } | { status: "ready"; caps: Capabilities } | { status: "error"; message: string };

interface Ctx {
  state: State;
  /** Null until the report has loaded. */
  caps: Capabilities | null;
  reload: () => void;
}

const CapabilitiesContext = createContext<Ctx | null>(null);

/** Loads the backend's capability report once and keeps it for every screen. */
export function CapabilitiesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let stale = false;
    jobsService
      .capabilities()
      .then((caps) => !stale && setState({ status: "ready", caps }))
      .catch((e) => !stale && setState({ status: "error", message: messageOf(e) }));
    return () => {
      stale = true;
    };
  }, [attempt]);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  const value = useMemo<Ctx>(() => ({ state, caps: state.status === "ready" ? state.caps : null, reload }), [state, reload]);
  return <CapabilitiesContext.Provider value={value}>{children}</CapabilitiesContext.Provider>;
}

export function useCapabilities(): Ctx {
  const c = useContext(CapabilitiesContext);
  if (!c) throw new Error("useCapabilities outside CapabilitiesProvider");
  return c;
}
