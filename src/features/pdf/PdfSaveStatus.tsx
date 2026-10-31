import { CheckCircle2, FolderOpen, Loader2, XCircle } from "lucide-react";
import { Button } from "../../components/Button";
import { useJobs } from "../../app/JobsProvider";
import { plural } from "../../lib/format";

/** Progress and outcome of the last "Save a copy" from the editor. It stays until dismissed. */
export function PdfSaveStatus() {
  const { jobs, currentByKind, dismissCurrent, cancel, reveal, isThisSession } = useJobs();
  const job = jobs.find((j) => j.id === currentByKind["pdf-pages"]);
  if (!job) return null;
  const active = job.status === "uploading" || job.status === "processing" || job.status === "saving";
  const failed = job.results.filter((r) => r.outcome === "failed");
  return (
    <div className={`save-status save-status--${active ? "busy" : job.status}`} role="status" aria-live="polite">
      {active ? <Loader2 size={18} className="spin" aria-hidden /> : job.status === "completed" ? <CheckCircle2 size={18} aria-hidden /> : <XCircle size={18} aria-hidden />}
      <div className="save-status__text">
        {active && (
          <>
            <strong>Saving “{job.title}”…</strong> {job.percent}%
          </>
        )}
        {job.status === "completed" && (
          <>
            <strong>Saved “{job.title}”</strong>
            {(job.filesSkipped ?? 0) > 0 ? ` · ${plural(job.filesSkipped ?? 0, "file")} skipped because a file with that name already exists` : ` · ${job.detail ?? ""}`}
          </>
        )}
        {job.status === "failed" && (
          <>
            <strong>The copy wasn't saved.</strong> {job.error?.message ?? failed[0]?.message ?? "Something went wrong."} Your original was not changed.
          </>
        )}
        {job.status === "cancelled" && <strong>Saving was cancelled. Your original was not changed.</strong>}
      </div>
      {active && (
        <Button size="sm" variant="danger" onClick={() => void cancel(job.id)} disabled={job.status === "saving"}>
          Cancel
        </Button>
      )}
      {job.status === "completed" && (
        <Button size="sm" icon={<FolderOpen size={15} aria-hidden />} onClick={() => void reveal(job)} disabled={!isThisSession(job) || job.outputs.length === 0}>
          Show in folder
        </Button>
      )}
      {!active && (
        <Button size="sm" variant="ghost" onClick={() => dismissCurrent("pdf-pages")}>
          Dismiss
        </Button>
      )}
    </div>
  );
}
