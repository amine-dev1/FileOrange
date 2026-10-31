import { useSyncExternalStore } from "react";
import { FR, FR_PATTERNS, FR_NOUNS } from "./fr.ts";

/**
 * Translation. The English text is the key: `t("Convert images")` is French when French is chosen and English otherwise, and
 * anything not translated yet simply stays English. `{name}` placeholders are filled from `vars`. Text that comes from the server
 * (option labels, notes, error messages) goes through the same function; messages with numbers or names in them are matched by
 * the patterns in fr.ts.
 */
export type Lang = "en" | "fr";
const KEY = "orangefile.lang";

function initial(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "en" || v === "fr") return v;
  } catch {
    /* no storage: follow the browser */
  }
  return typeof navigator !== "undefined" && /^fr\b/i.test(navigator.language || "") ? "fr" : "en";
}

let lang: Lang = initial();
const listeners = new Set<() => void>();
if (typeof document !== "undefined") document.documentElement.lang = lang;

export function getLang(): Lang {
  return lang;
}

export function setLang(l: Lang) {
  if (l === lang) return;
  lang = l;
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* remembered for this visit only */
  }
  document.documentElement.lang = l;
  listeners.forEach((f) => f());
}

/** Re-renders the caller when the language changes. */
export function useLang(): Lang {
  return useSyncExternalStore(
    (f) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    () => lang,
    () => lang,
  );
}

function fill(s: string, vars?: Record<string, string | number>): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** French for an English text, or null. Exact match first, then the patterns (for text with numbers or names in it). */
export function french(en: string): string | null {
  const exact = FR[en];
  if (exact !== undefined) return exact;
  const trimmed = en.trim();
  if (trimmed !== en && FR[trimmed] !== undefined) return en.replace(trimmed, FR[trimmed]);
  let out = en;
  for (const [re, to] of FR_PATTERNS) {
    re.lastIndex = 0;
    out = typeof to === "function" ? out.replace(re, (...args) => to(args.slice(0, -2) as unknown as RegExpExecArray)) : out.replace(re, to);
  }
  return out !== en ? out : null;
}

export function t(en: string, vars?: Record<string, string | number>): string {
  if (lang === "en" || !en) return fill(en, vars);
  return fill(french(en) ?? en, vars);
}

/** "1 file", "3 files"; in French, 0 and 1 take the singular. */
export function plural(n: number, one: string, many = `${one}s`): string {
  if (lang === "fr") {
    const fr = FR_NOUNS[one];
    if (fr) return `${n} ${n <= 1 ? fr[0] : fr[1]}`;
    return `${n} ${t(n <= 1 ? one : many)}`;
  }
  return `${n} ${n === 1 ? one : many}`;
}
