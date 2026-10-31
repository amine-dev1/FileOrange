import { Heart } from "lucide-react";
import { DONATE_URL } from "../lib/donate";

/** A quiet ask at the bottom of the dashboard. Opens PayPal in a new tab, so nothing in progress is lost. */
export function DonateCard() {
  return (
    <section aria-labelledby="donate-heading" className="flex flex-col gap-4 rounded-2xl border border-brand-200 bg-brand-50 p-5 sm:flex-row sm:items-center sm:justify-between dark:border-brand-900 dark:bg-brand-900/20">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-700 text-white">
          <Heart className="size-5" aria-hidden />
        </span>
        <div>
          <h2 id="donate-heading" className="font-semibold text-slate-900 dark:text-slate-100">
            Like OrangeFile? Help keep it free.
          </h2>
          <p className="mt-0.5 text-sm text-slate-700 dark:text-slate-300">No ads, no account. A donation pays for the server and new tools.</p>
        </div>
      </div>
      <a
        href={DONATE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-brand-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-800 dark:bg-brand-700 dark:hover:bg-brand-800"
      >
        <Heart className="size-4" aria-hidden /> Donate with PayPal
        <span className="sr-only">(opens in a new tab)</span>
      </a>
    </section>
  );
}
