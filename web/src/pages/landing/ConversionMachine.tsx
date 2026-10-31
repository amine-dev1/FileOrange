import { useEffect, useState } from "react";
import { t } from "../../lib/i18n";

/** Real conversions the site does, shown going through the machine one after another. */
const STEPS = [
  { from: ["report.docx"], to: "report.pdf", tool: "Documents to PDF", label: "Word to PDF" },
  { from: ["holiday.png"], to: "holiday.webp", tool: "Convert images", label: "PNG to WEBP" },
  { from: ["part-1.pdf", "part-2.pdf", "part-3.pdf"], to: "merged.pdf", tool: "Merge PDFs", label: "Three PDFs into one" },
  { from: ["scan.pdf"], to: "scan-1.jpg", tool: "PDF to pictures", label: "PDF to JPG" },
  { from: ["photos/"], to: "photos.zip", tool: "Make a ZIP", label: "Folder to ZIP" },
] as const;
const CYCLE_MS = 4200;

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function ext(name: string) {
  if (name.endsWith("/")) return "folder";
  return name.slice(name.lastIndexOf(".") + 1);
}

function FileCard({ name, done = false, className = "", style }: { name: string; done?: boolean; className?: string; style?: React.CSSProperties }) {
  return (
    <div
      className={`relative w-[7.5rem] shrink-0 rounded-xl border-2 border-aubergine bg-peel p-3 shadow-[4px_4px_0_0_var(--color-aubergine)] sm:w-36 ${className}`}
      style={style}
    >
      {/* folded corner */}
      <span aria-hidden className="absolute -top-0.5 -right-0.5 size-5 rounded-bl-md border-b-2 border-l-2 border-aubergine bg-pith" />
      <span className="block font-mono text-[0.7rem] font-bold tracking-wider text-aubergine-muted uppercase">{ext(name)}</span>
      <span className="mt-6 block h-1.5 w-4/5 rounded-full bg-pith" />
      <span className="mt-1.5 block h-1.5 w-3/5 rounded-full bg-pith" />
      <span className="mt-3 block truncate font-mono text-xs font-semibold text-aubergine sm:text-[0.8rem]">{name}</span>
      {done && (
        <span className="lp-stamp absolute -right-4 -bottom-3 rounded-md border-2 border-aubergine bg-mint px-2 py-0.5 font-mono text-[0.7rem] font-bold tracking-widest text-aubergine uppercase">
          {t("Done")}
        </span>
      )}
    </div>
  );
}

/**
 * The hero's signature: a file goes into a small press and comes out in the format you wanted. Pauses while the tab is hidden or
 * the pointer is on it; people who ask for reduced motion see a still picture of one conversion with a way to step through.
 */
export function ConversionMachine() {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const [still] = useState(reducedMotion);

  useEffect(() => {
    if (still || paused) return;
    const t = window.setInterval(() => {
      if (!document.hidden) setI((n) => (n + 1) % STEPS.length);
    }, CYCLE_MS);
    return () => window.clearInterval(t);
  }, [still, paused]);

  const s = STEPS[i];
  return (
    <figure className="relative mx-auto w-full max-w-[34rem]" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <div className="relative rounded-[1.75rem] border-2 border-aubergine bg-peel/70 p-4 shadow-[8px_8px_0_0_var(--color-aubergine)] backdrop-blur-sm sm:p-6">
        <div key={i} className="lp-cycle grid min-h-52 grid-cols-[1fr_auto_1fr] items-center gap-2 sm:gap-4" aria-hidden>
          {/* what goes in */}
          <div className="relative flex h-44 items-center justify-end">
            {s.from.map((f, n) => (
              <FileCard key={f} name={f} className={`lp-in ${n ? "absolute" : ""}`} style={n ? ({ right: `${n * 10}px`, top: `${10 + n * 8}px`, "--r": `${n * 4 - 4}deg` } as React.CSSProperties) : undefined} />
            ))}
          </div>

          {/* the press */}
          <div className="lp-body flex w-16 flex-col items-center gap-2 sm:w-20">
            <span className="lp-light size-2.5 rounded-full bg-mint shadow-[0_0_12px_2px_var(--color-mint)]" />
            <div className="flex h-28 w-full flex-col justify-between rounded-2xl border-2 border-aubergine bg-aubergine p-2">
              <span className="block h-1.5 rounded-full bg-night" />
              <span className="mx-auto block h-10 w-1.5 rounded-full bg-night">
                <span className="lp-bar block h-full w-full origin-bottom rounded-full bg-mint" />
              </span>
              <span className="block h-1.5 rounded-full bg-night" />
            </div>
            <span className="h-2 w-10 rounded-b-lg bg-aubergine" />
          </div>

          {/* what comes out */}
          <div className="flex h-44 items-center justify-start">
            <FileCard name={s.to} done className="lp-out" />
          </div>
        </div>

        <figcaption className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t-2 border-dashed border-aubergine/25 pt-4">
          <span className="font-mono text-xs font-semibold text-aubergine">
            <span className="text-aubergine-muted">{t("tool:")}</span> {t(s.tool)}
          </span>
          <span className="sr-only">
            {t("Animation showing what OrangeFile does, for example {from} becoming {to}.", { from: s.from.join(", "), to: s.to })}
          </span>
          <span className="flex gap-0.5" role="group" aria-label={t("Examples")}>
            {STEPS.map((x, n) => (
              <button
                key={x.label}
                type="button"
                aria-label={t("Show example: {label}", { label: t(x.label) })}
                aria-pressed={n === i}
                onClick={() => setI(n)}
                className="group grid h-6 place-items-center px-0.5"
              >
                <span className={`block h-2.5 rounded-full border border-aubergine transition-all ${n === i ? "w-7 bg-aubergine" : "w-2.5 bg-transparent group-hover:bg-aubergine/30"}`} />
              </button>
            ))}
          </span>
        </figcaption>
      </div>
    </figure>
  );
}
