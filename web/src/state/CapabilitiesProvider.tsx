import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError } from "../lib/api";
import type { Capabilities } from "../lib/types";

type State = { status: "loading" } | { status: "ready"; caps: Capabilities } | { status: "error"; message: string };

interface Ctx {
  state: State;
  caps: Capabilities | null;
  reload: () => void;
}

const CapabilitiesContext = createContext<Ctx | null>(null);

/** What the engine can do, asked of the backend once. Every screen is driven by this report, never by a list in the UI. */
export function CapabilitiesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let stale = false;
    api
      .capabilities()
      .then((caps) => !stale && setState({ status: "ready", caps }))
      .catch((e) => !stale && setState({ status: "error", message: e instanceof ApiError ? e.message : "Couldn't reach the processing service." }));
    return () => {
      stale = true;
    };
  }, [attempt]);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);
  const value = useMemo(() => ({ state, caps: state.status === "ready" ? state.caps : null, reload }), [state, reload]);
  return <CapabilitiesContext.Provider value={value}>{children}</CapabilitiesContext.Provider>;
}

export function useCapabilities(): Ctx {
  const c = useContext(CapabilitiesContext);
  if (!c) throw new Error("useCapabilities outside CapabilitiesProvider");
  return c;
}
