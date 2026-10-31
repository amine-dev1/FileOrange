import { useCallback, useState, type ReactNode } from "react";
import type { ConflictPolicy, JobRequest, OperationKind, PathInfo, Review } from "../../lib/types";
import { messageOf } from "../../lib/tauri";
import { jobsService } from "../../services/jobsService";
import { useJobs } from "../../app/JobsProvider";
import { ReviewDialog } from "./ReviewDialog";

interface Options {
  kind: OperationKind;
  inputs: PathInfo[];
  detail?: string | null;
  actionLabel: string;
  build: (policy: ConflictPolicy) => JobRequest | null;
  /** Called once the job has been handed to the backend. */
  onStarted?: () => void;
}

/**
 * Start sequence shared by all workflows:
 *   dry-run review -> (conflict dialog if needed) -> start the job.
 * Nothing is simulated: every step is a call to the Rust side.
 */
export function useRunFlow({ kind, inputs, detail, actionLabel, build, onStarted }: Options) {
  const { start } = useJobs();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Review | null>(null);

  const launch = useCallback(
    async (policy: ConflictPolicy) => {
      const request = build(policy);
      if (!request) return;
      setBusy(true);
      setError(null);
      try {
        await start({ kind, request, inputs, detail });
        onStarted?.();
      } catch (e) {
        setError(messageOf(e));
      } finally {
        setBusy(false);
      }
    },
    [build, detail, inputs, kind, onStarted, start],
  );

  const begin = useCallback(async () => {
    const request = build("rename");
    if (!request) return;
    setBusy(true);
    setError(null);
    try {
      const review = await jobsService.review(request);
      if (review.errors.length > 0) {
        setError(review.errors.join(" "));
        return;
      }
      if (review.conflicts.length > 0) {
        setPending(review);
        return;
      }
      await launch("rename");
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }, [build, launch]);

  const dialog: ReactNode = pending ? (
    <ReviewDialog
      review={pending}
      actionLabel={actionLabel}
      onClose={() => setPending(null)}
      onConfirm={(policy) => {
        setPending(null);
        void launch(policy);
      }}
    />
  ) : null;

  return { begin, busy, error, clearError: () => setError(null), dialog };
}
