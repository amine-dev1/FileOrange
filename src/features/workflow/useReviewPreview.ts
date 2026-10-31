import { useEffect, useState } from "react";
import type { JobRequest, Review } from "../../lib/types";
import { messageOf } from "../../lib/tauri";
import { jobsService } from "../../services/jobsService";

export interface Preview {
  review: Review | null;
  error: string | null;
  loading: boolean;
}

interface Result {
  key: string;
  review: Review | null;
  error: string | null;
}

const IDLE: Preview = { review: null, error: null, loading: false };

/** Dry-run the request (debounced) so warnings, conflicts and blocking problems
 *  show up before the user presses the main button. */
export function useReviewPreview(request: JobRequest | null, enabled = true): Preview {
  const [result, setResult] = useState<Result | null>(null);
  const key = request && enabled ? JSON.stringify(request) : null;

  useEffect(() => {
    if (!key) return;
    let stale = false;
    const t = window.setTimeout(() => {
      jobsService
        .review(JSON.parse(key) as JobRequest)
        .then((review) => !stale && setResult({ key, review, error: null }))
        .catch((e) => !stale && setResult({ key, review: null, error: messageOf(e) }));
    }, 350);
    return () => {
      stale = true;
      window.clearTimeout(t);
    };
  }, [key]);

  if (!key) return IDLE;
  // A result for an older request is not shown; we are "loading" until the new one lands.
  if (!result || result.key !== key) return { review: null, error: null, loading: true };
  return { review: result.review, error: result.error, loading: false };
}
