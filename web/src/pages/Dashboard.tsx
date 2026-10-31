import { ChevronRight } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { DropZone } from "../components/DropZone";
import { FileList } from "../components/FileList";
import { JobList } from "../components/JobList";
import { ToolCards } from "../components/ToolCards";
import { PageHeader, useDropIntoSelection } from "../components/ToolShell";
import { Button, Card, EmptyState } from "../components/ui";
import { toolsForFiles } from "../lib/capabilities";
import { greeting } from "../lib/format";
import { toolByOp } from "../lib/tools";
import { useCapabilities } from "../state/CapabilitiesProvider";
import { useEditor } from "../state/EditorProvider";
import { useJobs } from "../state/JobsProvider";
import { useSelection } from "../state/SelectionProvider";
import { Clock } from "lucide-react";

export function Dashboard() {
  const { caps } = useCapabilities();
  const { items, add, remove, clear } = useSelection();
  const { jobs } = useJobs();
  const { open } = useEditor();
  const navigate = useNavigate();
  useDropIntoSelection();

  const tools = caps ? toolsForFiles(caps, items) : [];
  const firstEnabled = tools.find((t) => t.enabled)?.id;
  const readable = caps ? [...new Set(caps.operations.filter((o) => o.available).flatMap((o) => o.inputs))] : [];
  const accept = caps ? caps.formats.filter((f) => readable.includes(f.id)).flatMap((f) => f.extensions) : [];

  return (
    <>
      <PageHeader title={greeting()} subtitle="Convert, compress, merge, annotate and transform your files. Nothing is kept longer than it takes to make the result." />

      <div className="flex flex-col gap-6">
        <DropZone onFiles={add} accept={accept} folders hint="or choose them from your computer. Nothing is uploaded until you start a tool." />

        {items.length > 0 && (
          <Card title="Selected files">
            <div className="flex flex-col gap-4">
              <FileList rows={items.map((item) => ({ item }))} onRemove={remove} onClear={clear} />
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-slate-600 dark:text-slate-400">Available tools</span>
                {tools.length === 0 && <span className="text-sm text-slate-600 dark:text-slate-400">Checking…</span>}
                {tools.map((t) => {
                  const def = toolByOp(t.id);
                  if (!def) return null;
                  return (
                    <Button
                      key={t.id}
                      variant={t.id === firstEnabled ? "primary" : "secondary"}
                      disabled={!t.enabled}
                      title={t.reason ?? undefined}
                      onClick={() => {
                        if (t.id === "pdf_view") void open(items[0].file);
                        navigate(def.path);
                      }}
                    >
                      {t.label}
                    </Button>
                  );
                })}
              </div>
              {tools.some((t) => !t.enabled) && (
                <ul aria-label="Why some tools are off" className="list-disc space-y-1 pl-5 text-xs text-slate-600 dark:text-slate-400">
                  {tools
                    .filter((t) => !t.enabled)
                    .map((t) => (
                      <li key={t.id}>
                        <strong className="font-semibold">{t.label}:</strong> {t.reason}
                      </li>
                    ))}
                </ul>
              )}
            </div>
          </Card>
        )}

        <section aria-labelledby="tools-heading">
          <h2 id="tools-heading" className="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">
            Tools
          </h2>
          <ToolCards />
        </section>

        <Card
          title="Recent jobs"
          action={
            <Link to="/jobs" className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline dark:text-brand-300">
              View all <ChevronRight className="size-4" aria-hidden />
            </Link>
          }
        >
          {jobs.length === 0 ? (
            <EmptyState icon={<Clock className="size-7" aria-hidden />} title="No jobs yet">
              Files you convert, compress or extract will be listed here.
            </EmptyState>
          ) : (
            <JobList jobs={jobs.slice(0, 5)} caption="Recent jobs" />
          )}
        </Card>
      </div>
    </>
  );
}
