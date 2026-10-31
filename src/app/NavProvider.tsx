import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export type Route =
  | "dashboard"
  | "convert"
  | "pdf-tools"
  | "pdf-editor"
  | "pdf-merge"
  | "pdf-split"
  | "images-to-pdf"
  | "pdf-to-images"
  | "office-to-pdf"
  | "compress"
  | "extract"
  | "jobs"
  | "settings"
  | "formats"
  | "notices";

/** Screens that live under another sidebar item keep that item highlighted. */
export function sidebarItemFor(route: Route): Route {
  if (route === "pdf-editor" || route === "pdf-merge" || route === "pdf-split" || route === "images-to-pdf" || route === "pdf-to-images" || route === "office-to-pdf") return "pdf-tools";
  if (route === "formats" || route === "notices") return "settings";
  return route;
}

interface Ctx {
  route: Route;
  go: (r: Route) => void;
}

const NavContext = createContext<Ctx | null>(null);

export function NavProvider({ children }: { children: ReactNode }) {
  const [route, go] = useState<Route>("dashboard");
  const value = useMemo(() => ({ route, go }), [route]);
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}

export function useNav(): Ctx {
  const c = useContext(NavContext);
  if (!c) throw new Error("useNav outside NavProvider");
  return c;
}
