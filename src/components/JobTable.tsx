import { ArrowRight, FolderOpen, Trash2, XCircle } from "lucide-react";
import { isActive, type JobRecord } from "../lib/types";
import { formatBytes, formatJobDate } from "../lib/format";
import { FileTypeIcon } from "./FileTypeIcon";
import { StatusBadge } from "./StatusBadge";
import { ProgressBar } from "./ProgressBar";
import { Menu, type MenuItem } from "./Menu";
import "./JobTable.css";

interface Props {
  jobs: JobRecord[];
  onReveal: (job: JobRecord) => void;
  onCancel: (job: JobRecord) => void;
  onRemove: (job: JobRecord) => void;
  /** Output can only be revealed for jobs run since the app started. */
  canReveal: (job: JobRecord) => boolean;
  caption: string;
  /** The dashboard shows four columns; the full history adds Size. */
  showSize?: boolean;
}

export function operationLabel(job: Pick<JobRecord, "kind" | "detail">): string {
  if (job.kind === "compress") return "Compress";
  if (job.kind === "extract") return "Extract";
  if (job.kind === "pdf-merge") return "Merge PDFs";
  if (job.kind === "pdf-split") return "Split PDF";
  if (job.kind === "images-to-pdf") return "Images to PDF";
  if (job.kind === "pdf-to-images") return job.detail ? `PDF to images (${job.detail})` : "PDF to images";
  if (job.kind === "office-to-pdf") return "Document to PDF";
  if (job.kind === "pdf-pages") return job.detail ? `Edit PDF (${job.detail})` : "Edit PDF";
  return job.detail ? `Convert (${job.detail})` : "Convert";
}

function iconName(job: JobRecord): string {
  // Compress shows the archive it makes; convert/extract show the source file.
  return job.title;
}

export function JobTable({ jobs, onReveal, onCancel, onRemove, canReveal, caption, showSize = false }: Props) {
  return (
    <table className="jobtable">
      <caption className="sr-only">{caption}</caption>
      <colgroup>
        {showSize ? (
          <>
            <col style={{ width: "22.2%" }} />
            <col style={{ width: "19.8%" }} />
            <col style={{ width: "17.1%" }} />
            <col style={{ width: "19.1%" }} />
          </>
        ) : (
          <>
            <col style={{ width: "29%" }} />
            <col style={{ width: "25.8%" }} />
            <col style={{ width: "21.6%" }} />
          </>
        )}
        <col />
        <col style={{ width: "52px" }} />
      </colgroup>
      <thead>
        <tr>
          <th scope="col">File name</th>
          <th scope="col">Operation</th>
          {showSize && <th scope="col">Size</th>}
          <th scope="col">Status</th>
          <th scope="col">Date</th>
          <th scope="col">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((job) => {
          const active = isActive(job);
          const items: MenuItem[] = [
            {
              label: "Show in folder",
              icon: <FolderOpen size={16} aria-hidden />,
              disabled: job.status !== "completed" || job.outputs.length === 0 || !canReveal(job),
              reason: job.status !== "completed" ? "Available when the job has completed" : "Only available for jobs run since OrangeFile started",
              onSelect: () => onReveal(job),
            },
            active
              ? { label: "Cancel job", icon: <XCircle size={16} aria-hidden />, onSelect: () => onCancel(job), danger: true }
              : { label: "Remove from history", icon: <Trash2 size={16} aria-hidden />, onSelect: () => onRemove(job), danger: true },
          ];
          const failedCount = job.results.filter((r) => r.outcome === "failed").length;
          return (
            <tr key={job.id}>
              <td>
                <div className="jobtable__file">
                  <FileTypeIcon name={iconName(job)} size={22} />
                  <div className="jobtable__filetext">
                    <span className="jobtable__name" title={job.inputNames.join(", ")}>
                      {job.title}
                    </span>
                    {job.status === "failed" && job.error && (
                      <span className="jobtable__err" title={job.error.message}>
                        {job.error.message}
                      </span>
                    )}
                    {job.status === "completed" && failedCount > 0 && <span className="jobtable__err">{failedCount} file(s) failed</span>}
                  </div>
                </div>
              </td>
              <td className="jobtable__op">{operationLabel(job)}</td>
              {showSize && (
                <td className="jobtable__size">
                  {formatBytes(job.inputBytes)}
                  {job.status === "completed" && job.outputBytes != null && (
                    <>
                      {" "}
                      <ArrowRight size={13} aria-label="to" className="jobtable__arrow" /> {formatBytes(job.outputBytes)}
                    </>
                  )}
                </td>
              )}
              <td>
                <div className="jobtable__status">
                  <StatusBadge job={job} />
                  {active && job.status !== "saving" && <ProgressBar percent={job.percent} label={`${job.title} progress`} />}
                </div>
              </td>
              <td className="jobtable__date">{formatJobDate(job.createdAt)}</td>
              <td className="jobtable__menu">
                <Menu label={`Actions for ${job.title}`} items={items} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Placeholder rows while the saved history is being read. */
export function JobTableSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="jobskel" role="status" aria-label="Loading recent jobs">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="jobskel__row">
          <span className="jobskel__icon" />
          <span className="jobskel__bar" style={{ width: `${34 - i * 5}%` }} />
          <span className="jobskel__bar" style={{ width: "14%" }} />
          <span className="jobskel__pill" />
        </div>
      ))}
    </div>
  );
}
