import { Ban, CheckCircle2, FolderOpen, XCircle } from "lucide-react";
import type { JobRecord } from "../../lib/types";
import { formatBytes, plural } from "../../lib/format";
import { Button } from "../../components/Button";
import { ProgressBar } from "../../components/ProgressBar";
import { Callout } from "../../components/Callout";
import { Card } from "../../components/Card";
import { useJobs } from "../../app/JobsProvider";
import "./RunPanel.css";

const VERB = { compress: "Compressing", convert: "Converting", extract: "Extracting", "pdf-merge": "Merging", "pdf-split": "Splitting", "pdf-pages": "Saving", "images-to-pdf": "Building the PDF from your images", "pdf-to-images": "Saving pages as images", "office-to-pdf": "Converting to PDF" } as const;

interface Props {
  job: JobRecord;
  /** Called for "Start another" / "Try again". */
  onReset: (keepFiles: boolean) => void;
}

export function RunPanel({ job, onReset }: Props) {
  const { cancel, reveal, isThisSession } = useJobs();
  const failedResults = job.results.filter((r) => r.outcome === "failed");

  if (job.status === "uploading" || job.status === "processing" || job.status === "saving") {
    const label =
      job.status === "uploading" ? "Preparing your files…" : job.status === "saving" ? "Saving results…" : `${VERB[job.kind]}…`;
    return (
      <Card className="run">
        <div className="run__head">
          <div className="run__spinner" aria-hidden />
          <div className="run__text">
            <h2 aria-live="polite">{label}</h2>
            <p className="selectable">{job.title}</p>
          </div>
          <Button variant="danger" size="sm" onClick={() => void cancel(job.id)} disabled={job.status === "saving"}>
            Cancel
          </Button>
        </div>
        <ProgressBar percent={job.percent} label={label} indeterminate={job.status === "saving"} />
        <p className="run__pct">{job.status === "saving" ? "Almost done" : `${job.percent}%`}</p>
      </Card>
    );
  }

  if (job.status === "completed") {
    const skipped = job.filesSkipped ?? 0;
    return (
      <Card className="run">
        <div className="run__head">
          <CheckCircle2 size={34} className="run__ok" aria-hidden />
          <div className="run__text">
            <h2>{failedResults.length ? "Finished with some problems" : "All done"}</h2>
            <p>
              {plural(job.filesSaved ?? 0, "file")} saved
              {job.outputBytes != null && ` · ${formatBytes(job.inputBytes)} → ${formatBytes(job.outputBytes)}`}
              {skipped > 0 && ` · ${plural(skipped, "file")} skipped`}
            </p>
          </div>
        </div>
        {failedResults.length > 0 && (
          <Callout tone="warning" title={`${plural(failedResults.length, "file")} couldn't be processed`}>
            <ul>
              {failedResults.map((r, i) => (
                <li key={i}>
                  <strong className="run__inline">{r.input}</strong>: {r.message}
                </li>
              ))}
            </ul>
          </Callout>
        )}
        <div className="run__actions">
          <Button variant="primary" icon={<FolderOpen size={17} aria-hidden />} onClick={() => void reveal(job)} disabled={!isThisSession(job) || job.outputs.length === 0}>
            Show in folder
          </Button>
          <Button onClick={() => onReset(false)}>Start another</Button>
        </div>
      </Card>
    );
  }

  const cancelled = job.status === "cancelled";
  return (
    <Card className="run">
      <div className="run__head">
        {cancelled ? <Ban size={34} className="run__muted" aria-hidden /> : <XCircle size={34} className="run__bad" aria-hidden />}
        <div className="run__text">
          <h2>{cancelled ? "Job cancelled" : "That didn't work"}</h2>
          <p>Your original files were not changed.</p>
        </div>
      </div>
      {!cancelled && (
        <Callout tone="error" title={job.error?.message ?? "The job failed."}>
          {failedResults.length > 1 && (
            <ul>
              {failedResults.map((r, i) => (
                <li key={i}>
                  <strong className="run__inline">{r.input}</strong>: {r.message}
                </li>
              ))}
            </ul>
          )}
        </Callout>
      )}
      <div className="run__actions">
        <Button variant="primary" onClick={() => onReset(true)}>
          Back to options
        </Button>
        <Button onClick={() => onReset(false)}>Start over</Button>
      </div>
    </Card>
  );
}
