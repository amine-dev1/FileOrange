import { Clock } from "lucide-react";
import { PageHeader } from "../components/ToolShell";
import { JobList } from "../components/JobList";
import { Button, Card, EmptyState } from "../components/ui";
import { useCapabilities } from "../state/CapabilitiesProvider";
import { useJobs } from "../state/JobsProvider";

export function JobsPage() {
  const { jobs, clearFinished } = useJobs();
  const { caps } = useCapabilities();
  const mins = caps?.limits.retention_seconds ? Math.round(caps.limits.retention_seconds / 60) : null;
  return (
    <>
      <PageHeader
        title="Recent jobs"
        subtitle={mins ? `Results are kept on the server for about ${mins} minutes, then deleted. This list only remembers what you did in this browser.` : "This list only remembers what you did in this browser."}
        actions={
          <Button variant="secondary" disabled={jobs.every((j) => j.phase === "uploading" || j.phase === "processing") || jobs.length === 0} onClick={clearFinished}>
            Clear finished
          </Button>
        }
      />
      <Card>
        {jobs.length === 0 ? (
          <EmptyState icon={<Clock className="size-7" aria-hidden />} title="No jobs yet">
            Files you convert, compress or extract will be listed here.
          </EmptyState>
        ) : (
          <JobList jobs={jobs} caption="All jobs" />
        )}
      </Card>
    </>
  );
}
