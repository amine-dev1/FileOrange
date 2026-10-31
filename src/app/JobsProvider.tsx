import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  isActive,
  type JobRecord,
  type JobRequest,
  type OperationKind,
  type PathInfo,
  type DesktopStatus,
} from "../lib/types";
import { AppError, messageOf } from "../lib/tauri";
import { basename } from "../lib/format";
import { jobsService } from "../services/jobsService";
import { historyService } from "../services/historyService";
import { useSettings } from "./SettingsProvider";
import { useToast } from "./ToastProvider";

const SESSION_ID = crypto.randomUUID();
const POLL_MS = 800;
const MAX_POLL_FAILURES = 5;

export interface StartJobInput {
  kind: OperationKind;
  request: JobRequest;
  inputs: PathInfo[];
  /** e.g. "WEBP → PNG" */
  detail?: string | null;
}

interface Ctx {
  jobs: JobRecord[];
  /** True while the saved history is being read. */
  loading: boolean;
  /** Job each workflow screen is currently showing (so progress survives navigation). */
  currentByKind: Record<OperationKind, string | null>;
  start: (input: StartJobInput) => Promise<JobRecord>;
  cancel: (id: string) => Promise<void>;
  remove: (id: string) => void;
  clearFinished: () => Promise<void>;
  reveal: (job: JobRecord) => Promise<void>;
  dismissCurrent: (kind: OperationKind) => void;
  isThisSession: (job: JobRecord) => boolean;
}

const JobsContext = createContext<Ctx | null>(null);

const NO_CURRENT: Record<OperationKind, string | null> = { compress: null, convert: null, extract: null, "pdf-merge": null, "pdf-split": null, "pdf-pages": null, "images-to-pdf": null, "pdf-to-images": null, "office-to-pdf": null };

/** `name` as a `.pdf` file name (or the fallback when it is blank). */
const pdfName = (name: string | null | undefined, fallback: string) => {
  const n = name?.trim() || fallback;
  return /\.pdf$/i.test(n) ? n : `${n}.pdf`;
};

function titleFor(kind: OperationKind, request: JobRequest, inputs: PathInfo[]): string {
  if (kind === "compress") {
    const op = request.operation;
    const name = op.type === "compress" ? op.archive_name?.trim() : "";
    if (name) return /\.zip$/i.test(name) ? name : `${name}.zip`;
    if (inputs.length === 1) return `${inputs[0].name.replace(/\.[^.]+$/, "")}.zip`;
    return "archive.zip";
  }
  const op = request.operation;
  if (op.type === "pdf_merge") return pdfName(op.output_name, "merged");
  if (op.type === "pdf_pages") return pdfName(op.output_name, `${(inputs[0]?.name ?? "document").replace(/\.[^.]+$/, "")} (edited)`);
  if (op.type === "images_to_pdf") return pdfName(op.output_name, inputs.length === 1 ? inputs[0].name.replace(/\.[^.]+$/, "") : "images");
  const first = inputs[0]?.name ?? "";
  return inputs.length > 1 ? `${first} +${inputs.length - 1} more` : first;
}

export function JobsProvider({ children }: { children: ReactNode }) {
  const { settings } = useSettings();
  const { push } = useToast();
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentByKind, setCurrent] = useState<Record<OperationKind, string | null>>(NO_CURRENT);
  const jobsRef = useRef(jobs);
  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);
  const inFlight = useRef(new Set<string>());
  const failures = useRef(new Map<string, number>());
  const downloading = useRef(new Set<string>());

  const patch = useCallback((id: string, p: Partial<JobRecord>) => {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...p } : j)));
  }, []);

  // Read the saved history once; jobs started meanwhile are kept.
  useEffect(() => {
    let stale = false;
    void historyService.load(SESSION_ID, settings.historyRetention).then((saved) => {
      if (stale) return;
      setJobs((now) => [...now, ...saved.filter((s) => !now.some((j) => j.id === s.id))]);
      setLoading(false);
    });
    return () => {
      stale = true;
    };
    // Only on first mount: later retention changes are applied when saving.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist (debounced) whenever the list or the retention preference changes,
  // but never before the saved history has been read (it would overwrite it).
  useEffect(() => {
    if (loading) return;
    const t = window.setTimeout(() => historyService.save(jobs, settings.historyRetention), 300);
    return () => window.clearTimeout(t);
  }, [jobs, loading, settings.historyRetention]);

  const fail = useCallback(
    (id: string, error: { code: string; message: string }, results?: JobRecord["results"]) => {
      patch(id, { status: "failed", error, finishedAt: Date.now(), ...(results ? { results } : {}) });
    },
    [patch],
  );

  const saveResult = useCallback(
    async (id: string) => {
      if (downloading.current.has(id)) return;
      downloading.current.add(id);
      patch(id, { status: "saving", percent: 100 });
      try {
        const sum = await jobsService.download(id);
        const job = jobsRef.current.find((j) => j.id === id);
        patch(id, {
          status: "completed",
          percent: 100,
          finishedAt: Date.now(),
          outputs: sum.outputs,
          outputBytes: sum.bytes_saved,
          filesSaved: sum.files_saved,
          filesSkipped: sum.files_skipped,
          ...(job?.kind === "compress" && sum.outputs[0] ? { title: basename(sum.outputs[0]) } : {}),
        });
      } catch (e) {
        fail(id, { code: e instanceof AppError ? e.code : "INTERNAL_ERROR", message: `Processing finished, but the result couldn't be saved. ${messageOf(e)}` });
      } finally {
        downloading.current.delete(id);
      }
    },
    [fail, patch],
  );

  const applyStatus = useCallback(
    (job: JobRecord, s: DesktopStatus) => {
      if (s.phase === "uploading") {
        const pct = s.upload.total > 0 ? Math.floor((s.upload.sent / s.upload.total) * 100) : 0;
        patch(job.id, { status: "uploading", percent: Math.min(pct, 100) });
      } else if (s.phase === "failed") {
        fail(job.id, s.error ?? { code: "INTERNAL_ERROR", message: "The upload failed." });
      } else if (s.phase === "cancelled") {
        patch(job.id, { status: "cancelled", finishedAt: Date.now() });
      } else if (s.job) {
        const j = s.job;
        if (j.status === "queued" || j.status === "running") {
          patch(job.id, { status: "processing", percent: j.progress.percent, results: j.results });
        } else if (j.status === "completed") {
          patch(job.id, { results: j.results });
          void saveResult(job.id);
        } else if (j.status === "cancelled") {
          patch(job.id, { status: "cancelled", finishedAt: Date.now(), results: j.results });
        } else {
          const firstFail = j.results.find((r) => r.outcome === "failed")?.message;
          fail(job.id, { code: j.error?.code ?? "FAILED", message: firstFail ?? j.error?.message ?? j.message ?? "The job failed." }, j.results);
        }
      }
    },
    [fail, patch, saveResult],
  );

  useEffect(() => {
    const tick = () => {
      for (const job of jobsRef.current) {
        if (!isActive(job) || job.status === "saving" || job.sessionId !== SESSION_ID || inFlight.current.has(job.id)) continue;
        inFlight.current.add(job.id);
        jobsService
          .status(job.id)
          .then((s) => {
            failures.current.delete(job.id);
            applyStatus(job, s);
          })
          .catch((e) => {
            const n = (failures.current.get(job.id) ?? 0) + 1;
            failures.current.set(job.id, n);
            const transient = e instanceof AppError && e.code === "SERVICE_UNAVAILABLE";
            if (!transient || n >= MAX_POLL_FAILURES) fail(job.id, { code: e instanceof AppError ? e.code : "INTERNAL_ERROR", message: messageOf(e) });
          })
          .finally(() => inFlight.current.delete(job.id));
      }
    };
    const t = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(t);
  }, [applyStatus, fail]);

  const start = useCallback(
    async ({ kind, request, inputs, detail = null }: StartJobInput) => {
      const id = await jobsService.start(request);
      const record: JobRecord = {
        id,
        sessionId: SESSION_ID,
        kind,
        title: titleFor(kind, request, inputs),
        detail,
        inputNames: inputs.map((i) => i.name),
        inputBytes: inputs.reduce((n, i) => n + i.size, 0),
        outputBytes: null,
        outputDir: request.output_dir,
        outputs: [],
        status: "uploading",
        percent: 0,
        createdAt: Date.now(),
        finishedAt: null,
        error: null,
        results: [],
        filesSaved: null,
        filesSkipped: null,
      };
      setJobs((prev) => [record, ...prev]);
      setCurrent((c) => ({ ...c, [kind]: id }));
      return record;
    },
    [],
  );

  const cancel = useCallback(
    async (id: string) => {
      try {
        await jobsService.cancel(id);
        patch(id, { status: "cancelled", finishedAt: Date.now() });
      } catch (e) {
        push("error", messageOf(e));
      }
    },
    [patch, push],
  );

  const remove = useCallback((id: string) => {
    setJobs((prev) => prev.filter((j) => j.id !== id || isActive(j)));
    setCurrent((c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v === id ? null : v])) as typeof c);
  }, []);

  const clearFinished = useCallback(async () => {
    setJobs((prev) => prev.filter(isActive));
    setCurrent(NO_CURRENT);
    historyService.clear();
    try {
      await jobsService.clearBackendHistory();
    } catch {
      /* nothing to clear outside the app */
    }
  }, []);

  const reveal = useCallback(
    async (job: JobRecord) => {
      const target = job.outputs[0];
      if (!target) return;
      try {
        await jobsService.reveal(target);
      } catch (e) {
        push("error", messageOf(e));
      }
    },
    [push],
  );

  const dismissCurrent = useCallback((kind: OperationKind) => setCurrent((c) => ({ ...c, [kind]: null })), []);
  const isThisSession = useCallback((job: JobRecord) => job.sessionId === SESSION_ID, []);

  const value = useMemo(
    () => ({ jobs, loading, currentByKind, start, cancel, remove, clearFinished, reveal, dismissCurrent, isThisSession }),
    [jobs, loading, currentByKind, start, cancel, remove, clearFinished, reveal, dismissCurrent, isThisSession],
  );
  return <JobsContext.Provider value={value}>{children}</JobsContext.Provider>;
}

export function useJobs(): Ctx {
  const c = useContext(JobsContext);
  if (!c) throw new Error("useJobs outside JobsProvider");
  return c;
}
