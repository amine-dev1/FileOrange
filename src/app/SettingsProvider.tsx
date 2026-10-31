import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { settingsService, type Settings } from "../services/settingsService";

interface Ctx {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}

const SettingsContext = createContext<Ctx | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(() => settingsService.load());
  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      settingsService.save(next);
      return next;
    });
  }, []);
  const value = useMemo(() => ({ settings, update }), [settings, update]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): Ctx {
  const c = useContext(SettingsContext);
  if (!c) throw new Error("useSettings outside SettingsProvider");
  return c;
}
