import { Ban, CheckCircle2, Download, Package, RotateCcw, XCircle } from "lucide-react";
import { formatBytes, plural } from "../lib/format";
import { useCapabilities } from "../state/CapabilitiesProvider";
import { isActive, useJobs, type JobRecord } from "../state/JobsProvider";
import { DownloadAnchor, DownloadLink } from "./Download";
import { FileIcon } from "./FileIcon";
import { Button, Callout, Card, ProgressBar, Spinner, cx } from "./ui";
import { t } from "../lib/i18n";

const VERB: Record<JobRecord["tool"], string> = {
  compress: "Compressing",
  convert: "Converting",
  resize: "Making your pictures smaller",
  extract: "Extracting",
  "pdf-merge": "Merging",
  "pdf-split": "Splitting",
  "pdf-pages": "Saving your PDF",
  "images-to-pdf": "Building the PDF",
  "pdf-to-images": "Saving pages as images",
  "office-to-pdf": "Converting to PDF",
  "pdf-compress": "Compressing your PDF",
  "pdf-protect": "Adding the password",
  "pdf-unlock": "Removing the password",
};

export function Results({ job }: { job: JobRecord }) {
  const files = job.manifest?.files ?? [];
  const id = job.serverId;
  if (!id) return null;
  const single = files.length === 1 && (job.manifest?.directories.length ?? 0) === 0;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {single ? (
          <DownloadLink primary job={id} index={files[0].index}>
            <Download className="size-4" aria-hidden /> {t("Download")} {files[0].path.split("/").pop()} <span className="font-normal opacity-80">({formatBytes(files[0].size)})</span>
          </DownloadLink>
        ) : (
          <DownloadLink primary job={id}>
            <Package className="size-4" aria-hidden /> {t("Download all as ZIP")}
          </DownloadLink>
        )}
      </div>
      <SizeChange job={job} />
      <DoneNotes job={job} />
      {files.length > 1 && (
        <details className="rounded-xl border border-slate-200 text-sm dark:border-slate-800" open={files.length <= 8}>
          <summary className="cursor-pointer select-none px-4 py-2.5 font-medium text-slate-700 dark:text-slate-300">{plural(files.length, "file")} {t("in this result")}</summary>
          <ul className="max-h-72 divide-y divide-slate-100 overflow-y-auto border-t border-slate-100 dark:divide-slate-800 dark:border-slate-800">
            {files.map((f) => (
              <li key={f.index} className="flex items-center gap-3 px-4 py-2">
                <FileIcon name={f.path} size={28} />
                <span className="min-w-0 flex-1 truncate" title={f.path}>
                  {f.path}
                </span>
                <span className="text-xs text-slate-600 dark:text-slate-400">{formatBytes(f.size)}</span>
                <DownloadAnchor className="rounded-md px-2 py-1 text-brand-700 hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-brand-900/30" job={id} index={f.index} label={`Download ${f.path}`}>
                  <Download className="size-4" aria-hidden />
                </DownloadAnchor>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** For tools whose point is often size: "2.4 MB → 380 KB, 84% smaller". Only when every file came through, so totals compare like with like. */
const SIZE_TOOLS: JobRecord["tool"][] = ["convert", "resize", "compress", "pdf-compress"];
function SizeChange({ job }: { job: JobRecord }) {
  const out = (job.manifest?.files ?? []).reduce((n, f) => n + f.size, 0);
  const before = job.inputBytes;
  if (!SIZE_TOOLS.includes(job.tool) || before <= 0 || out <= 0 || job.results.some((r) => r.outcome !== "done")) return null;
  const pct = Math.round(((before - out) / before) * 100);
  const smaller = pct > 0;
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm text-slate-700 dark:text-slate-300" data-testid="size-change">
      <span className="tabular-nums">
        {formatBytes(before)} → <strong className="font-semibold text-slate-900 dark:text-slate-100">{formatBytes(out)}</strong>
      </span>
      <span className={cx("rounded-full px-2 py-0.5 text-xs font-semibold", smaller ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300" : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300")}>
        {pct === 0 ? t("About the same size") : smaller ? t("{pct}% smaller", { pct }) : t("{pct}% larger", { pct: -pct })}
      </span>
    </p>
  );
}

/** What the engine said about files it finished, e.g. "Resized from 4000×3000 to 1920×1440 px." */
function DoneNotes({ job }: { job: JobRecord }) {
  const notes = job.results.filter((r) => r.outcome === "done" && r.message);
  if (notes.length === 0) return null;
  const shown = notes.slice(0, 20);
  return (
    <ul className="flex flex-col gap-1 text-sm text-slate-700 dark:text-slate-300">
      {shown.map((r, i) => (
        <li key={i}>
          {notes.length > 1 && <strong className="font-semibold">{r.input}: </strong>}
          {r.message ? t(r.message) : null}
        </li>
      ))}
      {notes.length > shown.length && <li className="text-slate-600 dark:text-slate-400">{t("…and {count} more.", { count: notes.length - shown.length })}</li>}
    </ul>
  );
}

export function FailureList({ job }: { job: JobRecord }) {
  const failed = job.results.filter((r) => r.outcome === "failed");
  if (failed.length === 0) return null;
  return (
    <Callout tone="warning" title={t("{count} couldn't be processed", { count: plural(failed.length, "file") })}>
      <ul>
        {failed.map((r, i) => (
          <li key={i}>
            <strong className="font-semibold">{r.input}</strong>: {r.message ? t(r.message) : null}
          </li>
        ))}
      </ul>
    </Callout>
  );
}

/** Progress while a job runs, then its result: what can be downloaded, what failed, and what to do next. */
export function RunPanel({ job, onReset }: { job: JobRecord; onReset: (keepFiles: boolean) => void }) {
  const { cancel } = useJobs();
  const { caps } = useCapabilities();
  const keepFor = caps?.limits.retention_seconds ? Math.round(caps.limits.retention_seconds / 60) : null;

  if (isActive(job)) {
    const uploading = job.phase === "uploading";
    const label = uploading ? t("Sending your files…") : `${t(VERB[job.tool])}…`;
    return (
      <Card>
        <div className="flex items-center gap-4">
          <Spinner className="size-7 text-brand-600" />
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100" aria-live="polite">
              {label}
            </h2>
            <p className="truncate text-sm text-slate-600 dark:text-slate-400">{job.currentFile && !uploading ? job.currentFile : job.title}</p>
          </div>
          <Button variant="danger" size="sm" onClick={() => cancel(job.id)}>
            {t("Cancel")}
          </Button>
        </div>
        <div className="mt-4">
          <ProgressBar percent={job.percent} label={label} indeterminate={!uploading && job.percent === 0} />
          <p className="mt-1.5 text-right text-xs tabular-nums text-slate-600 dark:text-slate-400">{uploading ? t("{done} of {total}", { done: formatBytes((job.inputBytes * job.percent) / 100), total: formatBytes(job.inputBytes) }) : `${job.percent}%`}</p>
        </div>
      </Card>
    );
  }

  if (job.phase === "completed") {
    const failed = job.results.filter((r) => r.outcome === "failed").length;
    const skipped = job.results.filter((r) => r.outcome === "skipped").length;
    return (
      <Card>
        <div className="flex items-start gap-4">
          <CheckCircle2 className="size-9 shrink-0 text-emerald-600" aria-hidden />
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{t(failed ? "Finished with some problems" : "All done")}</h2>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {job.title}
              {skipped > 0 && ` · ${t("{count} skipped", { count: plural(skipped, "file") })}`}
            </p>
          </div>
        </div>
        <div className="mt-5 flex flex-col gap-4">
          <Results job={job} />
          <FailureList job={job} />
          {keepFor && <p className="text-xs text-slate-600 dark:text-slate-400">{t("For your privacy the result is deleted from the server about {time} after it is made. Download it now.", { time: plural(keepFor, "minute") })}</p>}
          <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
            <Button onClick={() => onReset(false)}>{t("Start another")}</Button>
            <Button variant="ghost" onClick={() => onReset(true)}>
              {t("Change options and run again")}
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  const cancelled = job.phase === "cancelled";
  const expired = job.phase === "expired";
  const needsPassword = job.results.some((r) => r.error_code === "password_required" || r.error_code === "wrong_password");
  return (
    <Card>
      <div className="flex items-start gap-4">
        {cancelled || expired ? <Ban className="size-9 shrink-0 text-slate-400" aria-hidden /> : <XCircle className="size-9 shrink-0 text-red-600" aria-hidden />}
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{t(cancelled ? "Cancelled" : expired ? "This result is gone" : "That didn't work")}</h2>
          <p className="text-sm text-slate-600 dark:text-slate-400">{t(cancelled ? "Nothing was kept. Your files were not changed." : expired ? "Results are removed from the server after a short time." : (job.error?.message ?? "The job failed."))}</p>
        </div>
      </div>
      <div className="mt-5 flex flex-col gap-4">
        <FailureList job={job} />
        {needsPassword && <Callout tone="info">{t("A file needs a password. Go back, enter it in the password box, and run again.")}</Callout>}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" icon={<RotateCcw className="size-4" aria-hidden />} onClick={() => onReset(true)}>
            {t("Try again")}
          </Button>
          <Button onClick={() => onReset(false)}>{t("Start over")}</Button>
        </div>
      </div>
    </Card>
  );
}
