import type { ReactNode } from "react";
import type { OperationKind } from "../../lib/types";
import { PageHeader } from "../../components/PageHeader";
import { useJobs } from "../../app/JobsProvider";
import { useSelection } from "../../app/SelectionProvider";
import { RunPanel } from "./RunPanel";

/** Page frame shared by the three workflows: shows the form, or, once a job has
 *  started, its progress and result (which survives navigating away and back). */
export function WorkflowPage({ kind, title, subtitle, children }: { kind: OperationKind; title: string; subtitle: string; children: ReactNode }) {
  const { jobs, currentByKind, dismissCurrent } = useJobs();
  const { clear } = useSelection();
  const job = jobs.find((j) => j.id === currentByKind[kind]);
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} />
      {job ? (
        <RunPanel
          job={job}
          onReset={(keepFiles) => {
            dismissCurrent(kind);
            if (!keepFiles) clear();
          }}
        />
      ) : (
        <div className="card-stack">{children}</div>
      )}
    </>
  );
}
