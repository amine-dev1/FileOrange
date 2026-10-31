import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError, type UploadFile } from "../lib/api";
import type { FileOutcome, JobResponse, ResultManifest, ToolId } from "../lib/types";

export type JobPhase = "uploading" | "processing" | "completed" | "failed" | "cancelled" | "expired";

export interface JobRecord {
  id: string;
  serverId: string | null;
  tool: ToolId;
  title: string;
  detail: string | null;
  inputNames: string[];
  inputBytes: number;
  createdAt: number;
  finishedAt: number | null;
  phase: JobPhase;
  /** 0-100 for the current phase (sending files, then processing). */
  percent: number;
  currentFile: string | null;
  results: FileOutcome[];
  error: { code: string; message: string } | null;
  manifest: ResultManifest | null;
}

export interface StartInput {
  tool: ToolId;
  /** The API operation name: compress, convert, pdf_merge, … */
  operation: string;
  options: unknown;
  files: UploadFile[];
  title: string;
  detail?: string | null;
}

interface Ctx {
  jobs: JobRecord[];
  currentByTool: Partial<Record<ToolId, string>>;
  start: (input: StartInput) => string;
  cancel: (id: string) => void;
  remove: (id: string) => void;
  clearFinished: () => void;
  dismissCurrent: (tool: ToolId) => void;
}

const JobsContext = createContext<Ctx | null>(null);

const STORE = "orangefile.web.jobs.v1";
const MAX_HISTORY = 40;
const POLL_MS = 500;
const ACTIVE: JobPhase[] = ["uploading", "processing"];
export const isActive = (j: Pick<JobRecord, "phase">) => ACTIVE.includes(j.phase);

function load(): JobRecord[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? "[]") as JobRecord[];
    // A job that was running when the page closed can't be followed any more.
    return raw.map((j) => (isActive(j) ? { ...j, phase: "failed", error: { code: "INTERRUPTED", message: "This page was closed before the job finished." } } : j));
  } catch {
    return [];
  }
}

function save(jobs: JobRecord[]) {
  try {
    localStorage.setItem(STORE, JSON.stringify(jobs.filter((j) => !isActive(j)).slice(0, MAX_HISTORY)));
  } catch {
    /* storage unavailable: history just won't survive a reload */
  }
}

const fromServer = (j: JobRecord, s: JobResponse): JobRecord => {
  const finished = s.status === "completed" || s.status === "failed" || s.status === "cancelled";
  return {
    ...j,
    phase: s.status === "queued" || s.status === "running" ? "processing" : s.status,
    percent: finished ? 100 : s.progress.percent,
    currentFile: s.current_file,
    results: s.results,
    error: s.error ?? (s.status === "failed" && s.results.length === 0 ? { code: "FAILED", message: s.message ?? "The job failed." } : null),
    finishedAt: finished ? (j.finishedAt ?? Date.now()) : null,
  };
};

export function JobsProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<JobRecord[]>(load);
  const [currentByTool, setCurrent] = useState<Partial<Record<ToolId, string>>>({});
  const controllers = useRef(new Map<string, AbortController>());
  const jobsRef = useRef(jobs);
  useEffect(() => {
    jobsRef.current = jobs;
    save(jobs);
  }, [jobs]);

  const patch = useCallback((id: string, fn: (j: JobRecord) => JobRecord) => setJobs((all) => all.map((j) => (j.id === id ? fn(j) : j))), []);

  // Finished jobs from an earlier visit may have been deleted by the server's retention rule.
  useEffect(() => {
    for (const j of jobsRef.current) {
      if (j.phase !== "completed" || !j.serverId) continue;
      api.job(j.serverId).catch((e) => {
        if (e instanceof ApiError && e.status === 404) patch(j.id, (x) => ({ ...x, phase: "expired" }));
      });
    }
  }, [patch]);

  const start = useCallback(
    (input: StartInput) => {
      const id = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const total = input.files.reduce((n, f) => n + f.file.size, 0);
      const rec: JobRecord = {
        id,
        serverId: null,
        tool: input.tool,
        title: input.title,
        detail: input.detail ?? null,
        inputNames: input.files.map((f) => f.name),
        inputBytes: total,
        createdAt: Date.now(),
        finishedAt: null,
        phase: "uploading",
        percent: 0,
        currentFile: null,
        results: [],
        error: null,
        manifest: null,
      };
      setJobs((all) => [rec, ...all]);
      setCurrent((c) => ({ ...c, [input.tool]: id }));
      const ctl = new AbortController();
      controllers.current.set(id, ctl);

      const fail = (code: string, message: string) => patch(id, (j) => ({ ...j, phase: "failed", percent: 100, finishedAt: Date.now(), error: { code, message } }));
      api
        .createJob(input.operation, input.options, input.files, (sent, tot) => patch(id, (j) => (j.phase === "uploading" ? { ...j, percent: tot ? Math.round((sent / tot) * 100) : 0 } : j)), ctl.signal)
        .then((created) => {
          patch(id, (j) => ({ ...j, serverId: created.job_id, phase: "processing", percent: 0 }));
          void follow(id, created.job_id, ctl.signal);
        })
        .catch((e) => {
          if (e instanceof DOMException && e.name === "AbortError") patch(id, (j) => ({ ...j, phase: "cancelled", percent: 100, finishedAt: Date.now() }));
          else fail(e instanceof ApiError ? e.code : "ERROR", e instanceof Error ? e.message : "Something went wrong.");
        });
      return id;

      async function follow(localId: string, serverId: string, signal: AbortSignal) {
        let misses = 0;
        while (!signal.aborted) {
          await new Promise((r) => setTimeout(r, POLL_MS));
          try {
            const s = await api.job(serverId);
            misses = 0;
            patch(localId, (j) => fromServer(j, s));
            if (s.status === "completed") {
              const manifest = await api.manifest(serverId).catch(() => null);
              patch(localId, (j) => ({ ...j, manifest }));
            }
            if (s.status === "completed" || s.status === "failed" || s.status === "cancelled") break;
          } catch (e) {
            if (e instanceof ApiError && e.status === 404) return patch(localId, (j) => ({ ...j, phase: "expired", finishedAt: Date.now() }));
            if (++misses >= 6) return patch(localId, (j) => ({ ...j, phase: "failed", finishedAt: Date.now(), error: { code: "SERVICE_UNAVAILABLE", message: e instanceof Error ? e.message : "Lost contact with the service." } }));
          }
        }
        controllers.current.delete(localId);
      }
    },
    [patch],
  );

  const cancel = useCallback(
    (id: string) => {
      const j = jobsRef.current.find((x) => x.id === id);
      if (!j) return;
      if (j.phase === "uploading") controllers.current.get(id)?.abort();
      else if (j.phase === "processing" && j.serverId) void api.cancelJob(j.serverId).catch(() => undefined);
    },
    [],
  );

  const remove = useCallback((id: string) => {
    setJobs((all) => all.filter((j) => j.id !== id));
    setCurrent((c) => Object.fromEntries(Object.entries(c).filter(([, v]) => v !== id)));
  }, []);
  const clearFinished = useCallback(() => setJobs((all) => all.filter(isActive)), []);
  const dismissCurrent = useCallback((tool: ToolId) => setCurrent((c) => ({ ...c, [tool]: undefined })), []);

  const value = useMemo(() => ({ jobs, currentByTool, start, cancel, remove, clearFinished, dismissCurrent }), [jobs, currentByTool, start, cancel, remove, clearFinished, dismissCurrent]);
  return <JobsContext.Provider value={value}>{children}</JobsContext.Provider>;
}

export function useJobs(): Ctx {
  const c = useContext(JobsContext);
  if (!c) throw new Error("useJobs outside JobsProvider");
  return c;
}
