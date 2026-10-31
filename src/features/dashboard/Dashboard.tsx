import { ChevronRight, Clock, FileText, Folder, RefreshCw, Shrink } from "lucide-react";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { DropZone } from "../../components/DropZone";
import { EmptyState } from "../../components/EmptyState";
import { FileList } from "../../components/FileList";
import { JobTable, JobTableSkeleton } from "../../components/JobTable";
import { OperationCard } from "../../components/OperationCard";
import { PageHeader } from "../../components/PageHeader";
import { useCapabilities } from "../../app/CapabilitiesProvider";
import { useDragging } from "../../app/DropProvider";
import { useJobs } from "../../app/JobsProvider";
import { useNav, type Route } from "../../app/NavProvider";
import { usePdf } from "../../app/PdfProvider";
import { useSelection } from "../../app/SelectionProvider";
import { DEFAULT_USER_NAME } from "../../lib/config";
import { extensionsFor, toolsForFiles } from "../../lib/capabilities";
import { greeting } from "../../lib/format";
import { dialogService } from "../../services/dialogService";
import { quickActions } from "./quickActions";
import "./Dashboard.css";

const RECENT_COUNT = 5;
const ICONS = { convert: RefreshCw, "pdf-editor": FileText, compress: Shrink, extract: Folder } as const;
const TOOL_ROUTE: Record<string, Route> = { convert_image: "convert", compress: "compress", extract: "extract", pdf_view: "pdf-editor", pdf_merge: "pdf-merge", pdf_split: "pdf-split", images_to_pdf: "images-to-pdf", pdf_to_images: "pdf-to-images", office_to_pdf: "office-to-pdf" };

export function Dashboard() {
  const { go } = useNav();
  const { caps } = useCapabilities();
  const { items, add, remove, clear, busy } = useSelection();
  const { jobs, loading, cancel, remove: removeJob, reveal, isThisSession } = useJobs();
  const dragging = useDragging();
  const pdf = usePdf();

  const tools = caps ? toolsForFiles(caps, items) : [];
  const firstEnabled = tools.find((t) => t.enabled)?.id;

  const browse = async () => {
    // Offer every format an available tool can read, plus "all files" so nothing is hidden.
    const readable = caps ? [...new Set(caps.operations.filter((o) => o.available).flatMap((o) => o.inputs))] : [];
    const filters = readable.length ? [{ name: "Files OrangeFile can open", extensions: extensionsFor(caps!, readable) }, { name: "All files", extensions: ["*"] }] : undefined;
    add(await dialogService.pickFiles(filters, "Choose files"));
  };

  return (
    <>
      <PageHeader size="lg" title={`${greeting()}, ${DEFAULT_USER_NAME}`} subtitle="Manage and transform your files in one place." />

      <DropZone className="dash-drop" dragging={dragging} busy={busy} onBrowse={() => void browse()} />

      {items.length > 0 && (
        <Card title="Selected files">
          <div className="card-stack">
            <FileList rows={items.map((info) => ({ info }))} onRemove={remove} onClear={clear} />
            <div className="dash-actions">
              <span className="dash-actions__label">Available tools</span>
              {tools.length === 0 && <span className="dash-actions__label">Checking…</span>}
              {tools.map((t) => (
                <Button key={t.id} variant={t.id === firstEnabled ? "primary" : "secondary"} disabled={!t.enabled} title={t.reason ?? undefined} onClick={() => {
                    if (t.id === "pdf_view") void pdf.open(items[0].path);
                    go(TOOL_ROUTE[t.id]);
                  }}
                >
                  {t.label}
                </Button>
              ))}
            </div>
            {tools.some((t) => !t.enabled) && (
              <ul className="dash-why" aria-label="Why some tools are off">
                {tools.filter((t) => !t.enabled).map((t) => (
                  <li key={t.id}>
                    <strong>{t.label}:</strong> {t.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      )}

      <h2 className="section-title">Quick actions</h2>
      <div className="op-grid">
        {quickActions(caps).map((a) => (
          <OperationCard key={a.route} Icon={ICONS[a.route]} title={a.title} description={a.description} tag={a.tag} tagPosition="corner" onClick={() => go(a.route)} />
        ))}
      </div>

      <Card
        title="Recent jobs"
        action={
          <button className="link-btn" onClick={() => go("jobs")}>
            View all <ChevronRight size={17} aria-hidden />
          </button>
        }
      >
        {loading ? (
          <JobTableSkeleton />
        ) : jobs.length === 0 ? (
          <EmptyState icon={<Clock size={24} aria-hidden />} title="No jobs yet">
            Files you convert, compress or extract will be listed here.
          </EmptyState>
        ) : (
          <JobTable jobs={jobs.slice(0, RECENT_COUNT)} caption="Recent jobs" onReveal={(j) => void reveal(j)} onCancel={(j) => void cancel(j.id)} onRemove={(j) => removeJob(j.id)} canReveal={isThisSession} />
        )}
      </Card>
    </>
  );
}
