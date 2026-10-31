import { Ban, CheckCircle2, XCircle } from "lucide-react";
import type { JobRecord } from "../lib/types";
import "./StatusBadge.css";

export function StatusBadge({ job }: { job: Pick<JobRecord, "status" | "percent" | "results"> }) {
  switch (job.status) {
    case "completed": {
      const failed = job.results.filter((r) => r.outcome === "failed").length;
      return (
        <span className="badge badge--done" title={failed ? `${failed} file(s) could not be processed` : undefined}>
          <CheckCircle2 size={15} aria-hidden /> Completed
        </span>
      );
    }
    case "failed":
      return (
        <span className="badge badge--failed">
          <XCircle size={15} aria-hidden /> Failed
        </span>
      );
    case "cancelled":
      return (
        <span className="badge badge--cancelled">
          <Ban size={15} aria-hidden /> Cancelled
        </span>
      );
    default: {
      const label = job.status === "uploading" ? "Uploading" : job.status === "saving" ? "Saving" : "Processing";
      const pct = job.status === "saving" ? "" : ` (${job.percent}%)`;
      return (
        <span className="badge badge--active" role="status">
          <span className="badge__spinner" aria-hidden />
          {label}
          {pct}
        </span>
      );
    }
  }
}
