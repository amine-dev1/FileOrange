import { DonateCard } from "../components/DonateCard";
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
import { t } from "../lib/i18n";

export function Dashboard() {
  const { caps } = useCapabilities();
  const { items, add, remove, clear } = useSelection();
  const { jobs } = useJobs();
  const { open } = useEditor();
  const navigate = useNavigate();
  useDropIntoSelection();

  const tools = caps ? toolsForFiles(caps, items) : [];
  const firstEnabled = tools.find((c) => c.enabled)?.id;
  const readable = caps ? [...new Set(caps.operations.filter((o) => o.available).flatMap((o) => o.inputs))] : [];
  const accept = caps ? caps.formats.filter((f) => readable.includes(f.id)).flatMap((f) => f.extensions) : [];

  return (
    <>
      <PageHeader title={greeting()} subtitle={t("Convert, compress, merge, annotate and transform your files. Nothing is kept longer than it takes to make the result.")} />

      <div className="flex flex-col gap-6">
        <DropZone onFiles={add} accept={accept} folders hint={t("or choose them from your computer. Nothing is uploaded until you start a tool.")} />

        {items.length > 0 && (
          <Card title={t("Selected files")}>
            <div className="flex flex-col gap-4">
              <FileList rows={items.map((item) => ({ item }))} onRemove={remove} onClear={clear} />
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-slate-600 dark:text-slate-400">{t("Available tools")}</span>
                {tools.length === 0 && <span className="text-sm text-slate-600 dark:text-slate-400">{t("Checking…")}</span>}
                {tools.map((c) => {
                  const def = toolByOp(c.id);
                  if (!def) return null;
                  return (
                    <Button
                      key={c.id}
                      variant={c.id === firstEnabled ? "primary" : "secondary"}
                      disabled={!c.enabled}
                      title={c.reason ? t(c.reason) : undefined}
                      onClick={() => {
                        if (c.id === "pdf_view") void open(items[0].file);
                        navigate(def.path);
                      }}
                    >
                      {t(c.label)}
                    </Button>
                  );
                })}
              </div>
              {tools.some((c) => !c.enabled) && (
                <ul aria-label={t("Why some tools are off")} className="list-disc space-y-1 pl-5 text-xs text-slate-600 dark:text-slate-400">
                  {tools
                    .filter((c) => !c.enabled)
                    .map((c) => (
                      <li key={c.id}>
                        <strong className="font-semibold">{t(c.label)}:</strong> {c.reason ? t(c.reason) : null}
                      </li>
                    ))}
                </ul>
              )}
            </div>
          </Card>
        )}

        <section aria-labelledby="tools-heading">
          <h2 id="tools-heading" className="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">
            {t("Tools")}
          </h2>
          <ToolCards />
        </section>

        <Card
          title={t("Recent jobs")}
          action={
            <Link to="/jobs" className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline dark:text-brand-300">
              {t("View all")} <ChevronRight className="size-4" aria-hidden />
            </Link>
          }
        >
          {jobs.length === 0 ? (
            <EmptyState icon={<Clock className="size-7" aria-hidden />} title={t("No jobs yet")}>
              {t("Files you convert, compress or extract will be listed here.")}
            </EmptyState>
          ) : (
            <JobList jobs={jobs.slice(0, 5)} caption={t("Recent jobs")} />
          )}
        </Card>

        <DonateCard />
      </div>
    </>
  );
}
