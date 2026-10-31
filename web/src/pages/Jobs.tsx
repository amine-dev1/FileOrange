import { Clock } from "lucide-react";
import { PageHeader } from "../components/ToolShell";
import { JobList } from "../components/JobList";
import { Button, Card, EmptyState } from "../components/ui";
import { useCapabilities } from "../state/CapabilitiesProvider";
import { useJobs } from "../state/JobsProvider";
import { t } from "../lib/i18n";

export function JobsPage() {
  const { jobs, clearFinished } = useJobs();
  const { caps } = useCapabilities();
  const mins = caps?.limits.retention_seconds ? Math.round(caps.limits.retention_seconds / 60) : null;
  return (
    <>
      <PageHeader
        title={t("Recent jobs")}
        subtitle={mins ? t("Results are kept on the server for about {mins} minutes, then deleted. This list only remembers what you did in this browser.", { mins }) : t("This list only remembers what you did in this browser.")}
        actions={
          <Button variant="secondary" disabled={jobs.every((j) => j.phase === "uploading" || j.phase === "processing") || jobs.length === 0} onClick={clearFinished}>
            {t("Clear finished")}
          </Button>
        }
      />
      <Card>
        {jobs.length === 0 ? (
          <EmptyState icon={<Clock className="size-7" aria-hidden />} title={t("No jobs yet")}>
            {t("Files you convert, compress or extract will be listed here.")}
          </EmptyState>
        ) : (
          <JobList jobs={jobs} caption={t("All jobs")} />
        )}
      </Card>
    </>
  );
}
