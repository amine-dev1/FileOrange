import type { JobRecord } from "../lib/types";
import { isActive } from "../lib/types";
import { retentionDays, type HistoryRetention } from "./settingsService";

/**
 * Job history. The backend only knows about jobs of the running session, so
 * the UI keeps a local record (names, sizes, status, dates; never file
 * contents or passwords). If the backend later gains a history endpoint,
 * replace the body of `load`/`save` here and nothing else changes.
 */
const KEY = "orangefile.history.v1";
const MAX_ENTRIES = 500;

export const historyService = {
  /** Async on purpose: today it reads local storage, but a backend history endpoint can replace this body. */
  async load(currentSession: string, retention: HistoryRetention): Promise<JobRecord[]> {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return [];
      const jobs = JSON.parse(raw) as JobRecord[];
      return prune(jobs, retention).map((j) =>
        // A job that was running when the app closed can't be resumed.
        isActive(j) && j.sessionId !== currentSession
          ? {
              ...j,
              status: "failed" as const,
              finishedAt: j.finishedAt ?? Date.now(),
              error: { code: "INTERRUPTED", message: "OrangeFile was closed before this job finished." },
            }
          : j,
      );
    } catch {
      return [];
    }
  },
  save(jobs: JobRecord[], retention: HistoryRetention) {
    try {
      if (retention === "off") {
        localStorage.removeItem(KEY);
        return;
      }
      localStorage.setItem(KEY, JSON.stringify(prune(jobs, retention).slice(0, MAX_ENTRIES)));
    } catch {
      /* ignore: history is a convenience */
    }
  },
  clear() {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  },
};

function prune(jobs: JobRecord[], retention: HistoryRetention): JobRecord[] {
  const days = retentionDays(retention);
  if (days === null) return jobs;
  const cutoff = Date.now() - days * 86_400_000;
  return jobs.filter((j) => j.createdAt >= cutoff);
}
