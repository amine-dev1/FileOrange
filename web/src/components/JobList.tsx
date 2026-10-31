import { Download, Trash2, XCircle } from "lucide-react";
import { formatBytes, formatJobDate } from "../lib/format";
import { isActive, useJobs, type JobRecord } from "../state/JobsProvider";
import { DownloadAnchor } from "./Download";
import { FileIcon } from "./FileIcon";
import { Badge, IconButton, ProgressBar } from "./ui";
import { plural, t } from "../lib/i18n";

export function operationLabel(j: Pick<JobRecord, "tool" | "detail">): string {
  const d = j.detail ? ` (${t(j.detail)})` : "";
  switch (j.tool) {
    case "compress":
      return t("Make a ZIP");
    case "extract":
      return t("Extract");
    case "convert":
      return t("Convert") + d;
    case "resize":
      return t("Compress images") + d;
    case "pdf-merge":
      return t("Merge PDFs");
    case "pdf-split":
      return t("Split PDF");
    case "pdf-pages":
      return t("Edit PDF") + d;
    case "images-to-pdf":
      return t("Images to PDF");
    case "pdf-to-images":
      return t("PDF to images") + d;
    case "office-to-pdf":
      return t("Document to PDF");
    case "pdf-compress":
      return t("Compress PDF") + d;
    case "pdf-protect":
      return t("Add a password");
    case "pdf-unlock":
      return t("Remove a password");
  }
}

function StatusBadge({ job }: { job: JobRecord }) {
  switch (job.phase) {
    case "uploading":
      return <Badge tone="brand">{t("Sending")}</Badge>;
    case "processing":
      return <Badge tone="brand">{t("Working")}</Badge>;
    case "completed":
      return <Badge tone="green">{t("Done")}</Badge>;
    case "failed":
      return <Badge tone="red">{t("Failed")}</Badge>;
    case "cancelled":
      return <Badge>{t("Cancelled")}</Badge>;
    case "expired":
      return <Badge tone="amber">{t("Expired")}</Badge>;
  }
}

export function JobList({ jobs, caption }: { jobs: JobRecord[]; caption: string }) {
  const { cancel, remove } = useJobs();
  return (
    <ul aria-label={caption} className="divide-y divide-slate-100 dark:divide-slate-800">
      {jobs.map((job) => {
        const files = job.manifest?.files ?? [];
        const single = files.length === 1 && (job.manifest?.directories.length ?? 0) === 0;
        const canDownload = !!job.serverId && job.phase === "completed" && files.length > 0;
        const failed = job.results.filter((r) => r.outcome === "failed").length;
        return (
          <li key={job.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
            <FileIcon name={job.title} />
            <div className="min-w-0 flex-1 basis-56">
              <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100" title={job.inputNames.join(", ")}>
                {job.title}
              </p>
              <p className="truncate text-xs text-slate-600 dark:text-slate-400">
                {operationLabel(job)} · {formatBytes(job.inputBytes)} · {formatJobDate(job.createdAt)}
              </p>
              {job.phase === "failed" && job.error && <p className="truncate text-xs text-red-700 dark:text-red-300">{t(job.error.message)}</p>}
              {job.phase === "completed" && failed > 0 && <p className="text-xs text-amber-700 dark:text-amber-300">{t("{count} couldn't be processed", { count: plural(failed, "file") })}</p>}
            </div>
            <div className="flex w-40 flex-col items-start gap-1">
              <StatusBadge job={job} />
              {isActive(job) && <ProgressBar percent={job.percent} label={t("{name} progress", { name: job.title })} indeterminate={job.phase === "processing" && job.percent === 0} />}
            </div>
            <div className="flex items-center gap-1">
              {canDownload && job.serverId && (
                <DownloadAnchor job={job.serverId} index={single ? files[0].index : undefined} label={t("Download result of {name}", { name: job.title })} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800">
                  <Download className="size-4" aria-hidden /> {t("Download")}
                </DownloadAnchor>
              )}
              {isActive(job) ? (
                <IconButton label={t("Cancel {name}", { name: job.title })} onClick={() => cancel(job.id)}>
                  <XCircle className="size-4" aria-hidden />
                </IconButton>
              ) : (
                <IconButton label={t("Remove {name} from the list", { name: job.title })} onClick={() => remove(job.id)}>
                  <Trash2 className="size-4" aria-hidden />
                </IconButton>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
