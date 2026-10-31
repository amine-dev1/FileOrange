import { useMemo, useState } from "react";
import { Clock, Search, Trash2 } from "lucide-react";
import { Card } from "../../components/Card";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";
import { JobTable, JobTableSkeleton, operationLabel } from "../../components/JobTable";
import { useJobs } from "../../app/JobsProvider";
import { isActive, type JobRecord } from "../../lib/types";
import "./JobsPage.css";

type Filter = "all" | "processing" | "completed" | "failed" | "cancelled";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "processing", label: "Processing" },
  { id: "completed", label: "Completed" },
  { id: "failed", label: "Failed" },
  { id: "cancelled", label: "Cancelled" },
];

const matches = (j: JobRecord, f: Filter) => (f === "all" ? true : f === "processing" ? isActive(j) : j.status === f);

export function JobsPage() {
  const { jobs, loading, cancel, remove, reveal, clearFinished, isThisSession } = useJobs();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [confirm, setConfirm] = useState(false);

  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, jobs.filter((j) => matches(j, f.id)).length])) as Record<Filter, number>, [jobs]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return jobs.filter((j) => matches(j, filter) && (!q || [j.title, operationLabel(j), ...j.inputNames].some((s) => s.toLowerCase().includes(q))));
  }, [jobs, filter, query]);
  const finished = jobs.filter((j) => !isActive(j)).length;

  return (
    <>
      <PageHeader
        title="Recent Jobs"
        subtitle="Everything you've compressed, converted or extracted."
        actions={
          <Button icon={<Trash2 size={16} aria-hidden />} onClick={() => setConfirm(true)} disabled={finished === 0}>
            Clear history
          </Button>
        }
      />
      <Card>
        <div className="jobs-toolbar">
          <div className="jobs-filters" role="group" aria-label="Filter by status">
            {FILTERS.map((f) => (
              <button key={f.id} className={`chip ${filter === f.id ? "chip--on" : ""}`} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label} <span>{counts[f.id]}</span>
              </button>
            ))}
          </div>
          <label className="jobs-search">
            <Search size={16} aria-hidden />
            <input type="search" placeholder="Search jobs" aria-label="Search jobs" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
        </div>
        {loading ? (
          <JobTableSkeleton />
        ) : visible.length === 0 ? (
          jobs.length === 0 ? (
            <EmptyState icon={<Clock size={24} aria-hidden />} title="No jobs yet">
              Files you convert, compress or extract will be listed here.
            </EmptyState>
          ) : (
            <EmptyState icon={<Search size={24} aria-hidden />} title="No matching jobs">
              Try a different filter or search term.
            </EmptyState>
          )
        ) : (
          <JobTable showSize jobs={visible} caption="Job history" onReveal={(j) => void reveal(j)} onCancel={(j) => void cancel(j.id)} onRemove={(j) => remove(j.id)} canReveal={isThisSession} />
        )}
      </Card>
      <Dialog
        open={confirm}
        title="Clear job history?"
        description="This removes the list of past jobs from this computer. The files you created are not touched."
        onClose={() => setConfirm(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setConfirm(false);
                void clearFinished();
              }}
            >
              Clear history
            </Button>
          </>
        }
      >
        <p style={{ fontSize: 14 }}>{finished} finished job(s) will be removed. Jobs that are still running keep going.</p>
      </Dialog>
    </>
  );
}
