import { useState, type ReactNode } from "react";
import { t } from "../lib/i18n";
import { api } from "../lib/api";
import { API_BASE } from "../lib/base";
import { isHosted } from "../lib/session";
import { cx } from "./ui";

const BASE = API_BASE;
const direct = (job: string, index?: number) => (index == null ? `${BASE}/jobs/${encodeURIComponent(job)}/result` : `${BASE}/jobs/${encodeURIComponent(job)}/result/files/${index}`);

/**
 * A download. A real link, so the browser saves it itself and large files go straight to disk. Against a local engine that is all it
 * is. On a hosted server the plain address can't carry the visitor's session, so a click first asks for a short-lived signed one.
 */
export function DownloadAnchor({ job, index, className, children, label }: { job: string; index?: number; className?: string; children: ReactNode; label?: string }) {
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <>
      <a
        href={direct(job, index)}
        download
        aria-label={label}
        className={className}
        onClick={(e) => {
          if (!isHosted()) return;
          e.preventDefault();
          setProblem(null);
          api.download(job, index).catch((err) => setProblem(err instanceof Error ? err.message : "The download couldn't start."));
        }}
      >
        {children}
      </a>
      {problem && (
        <span role="alert" className="basis-full text-xs text-red-700 dark:text-red-300">
          {t(problem)}
        </span>
      )}
    </>
  );
}

/** The same, dressed as a button. */
export function DownloadLink({ job, index, children, primary = false, className }: { job: string; index?: number; children: ReactNode; primary?: boolean; className?: string }) {
  return (
    <DownloadAnchor
      job={job}
      index={index}
      className={cx(
        "inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium shadow-sm transition-colors",
        primary ? "bg-brand-700 text-white hover:bg-brand-800" : "border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800",
        className,
      )}
    >
      {children}
    </DownloadAnchor>
  );
}
