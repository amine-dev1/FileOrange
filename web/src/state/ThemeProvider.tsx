import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ThemeChoice = "system" | "light" | "dark";
const KEY = "orangefile.web.theme";

interface Ctx {
  choice: ThemeChoice;
  setChoice: (c: ThemeChoice) => void;
}
const ThemeContext = createContext<Ctx | null>(null);

function stored(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

const apply = (choice: ThemeChoice) => {
  const dark = choice === "dark" || (choice === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
};

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceRaw] = useState<ThemeChoice>(stored);
  useEffect(() => {
    apply(choice);
    if (choice !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => apply("system");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [choice]);
  const setChoice = useCallback((c: ThemeChoice) => {
    setChoiceRaw(c);
    try {
      localStorage.setItem(KEY, c);
    } catch {
      /* ignore */
    }
  }, []);
  const value = useMemo(() => ({ choice, setChoice }), [choice, setChoice]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Ctx {
  const c = useContext(ThemeContext);
  if (!c) throw new Error("useTheme outside ThemeProvider");
  return c;
}
