import { setLang, t, useLang, type Lang } from "../lib/i18n";
import { cx } from "./ui";

const LANGS: { v: Lang; short: string; name: string }[] = [
  { v: "en", short: "EN", name: "English" },
  { v: "fr", short: "FR", name: "Français" },
];

/** English / Français. Remembered in this browser; the first visit follows the browser's language. */
/** On the landing page the header is see-through over the orange hero, then dark or light once scrolled. */
export function LanguageSwitch({ tone = "app", scrolled = false }: { tone?: "app" | "landing"; scrolled?: boolean }) {
  const lang = useLang();
  return (
    <div role="radiogroup" aria-label={t("Language")} className={cx("inline-flex rounded-lg p-0.5", tone === "app" ? "bg-slate-100 dark:bg-slate-800" : cx("bg-aubergine/10", scrolled && "dark:bg-peel/10"))}>
      {LANGS.map((l) => (
        <button
          key={l.v}
          type="button"
          role="radio"
          aria-checked={lang === l.v}
          aria-label={l.name}
          lang={l.v}
          title={l.name}
          onClick={() => setLang(l.v)}
          className={cx(
            "h-7 rounded-md px-2 text-xs font-semibold",
            tone === "app"
              ? lang === l.v
                ? "bg-white text-brand-700 shadow-sm dark:bg-slate-950 dark:text-brand-300"
                : "text-slate-600 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
              : lang === l.v
                ? cx("bg-aubergine text-peel", scrolled && "dark:bg-peel dark:text-aubergine")
                : cx("text-aubergine hover:bg-aubergine/10", scrolled && "dark:text-peel dark:hover:bg-peel/10"),
          )}
        >
          {l.short}
        </button>
      ))}
    </div>
  );
}
