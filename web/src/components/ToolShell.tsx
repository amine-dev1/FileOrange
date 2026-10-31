import { RefreshCw } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { formatForFileName, labels, operationState } from "../lib/capabilities";
import type { FileItem } from "../lib/files";
import { uploadName } from "../lib/files";
import type { Preview } from "../lib/usePreview";
import type { OperationReport, ToolId } from "../lib/types";
import { useJobs } from "../state/JobsProvider";
import { useCapabilities } from "../state/CapabilitiesProvider";
import { useSelection } from "../state/SelectionProvider";
import { useOnDrop } from "../state/DropProvider";
import type { FileRow } from "./FileList";
import { RunPanel } from "./RunPanel";
import { Button, Callout, Card, Spinner } from "./ui";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-sm text-slate-600 dark:text-slate-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** Shows the tool only when the engine says it can run it; otherwise says why, so nothing is offered that can't work. */
export function CapabilityGate({ opId, children }: { opId: string; children: (op: OperationReport) => ReactNode }) {
  const { state, reload } = useCapabilities();
  if (state.status === "loading")
    return (
      <Card>
        <p role="status" className="flex items-center gap-3 text-sm text-slate-600 dark:text-slate-400">
          <Spinner /> Checking what this service can do…
        </p>
      </Card>
    );
  if (state.status === "error")
    return (
      <Callout tone="error" title="Couldn't reach the processing service">
        <p>{state.message}</p>
        <Button size="sm" className="mt-3" icon={<RefreshCw className="size-4" aria-hidden />} onClick={reload}>
          Try again
        </Button>
      </Callout>
    );
  const op = operationState(state.caps, opId);
  if (op.state === "ready") return <>{children(op.op)}</>;
  return (
    <Callout tone="warning" title={op.state === "unavailable" ? "This tool isn't available right now" : "Not available in this version"}>
      {op.reason}
    </Callout>
  );
}

/** Page frame shared by every tool: header, availability gate, and the progress/result panel once a job has started. */
export function ToolShell({ tool, opId, title, subtitle, children }: { tool: ToolId; opId: string; title: string; subtitle: string; children: (op: OperationReport) => ReactNode }) {
  const { jobs, currentByTool, dismissCurrent } = useJobs();
  const { clear } = useSelection();
  const job = jobs.find((j) => j.id === currentByTool[tool]);
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} />
      {job ? (
        <RunPanel
          job={job}
          onReset={(keepFiles) => {
            dismissCurrent(tool);
            if (!keepFiles) clear();
          }}
        />
      ) : (
        <div className="flex flex-col gap-5">
          <CapabilityGate opId={opId}>{children}</CapabilityGate>
        </div>
      )}
    </>
  );
}

/** Which of the selected files the tool can read, judged by name; the server checks the real content. */
export function useToolRows(op: OperationReport, items: FileItem[]): { rows: FileRow[]; valid: boolean } {
  const { caps } = useCapabilities();
  return useMemo(() => {
    const rows = items.map((item) => {
      let problem: string | undefined;
      if (caps && op.inputs.length > 0) {
        const fmt = formatForFileName(caps, item.name);
        if (!fmt || !op.inputs.includes(fmt.id)) problem = `Not a supported file (${labels(caps, op.inputs)}). Remove it to continue.`;
      }
      return { item, problem };
    });
    return { rows, valid: rows.length > 0 && rows.every((r) => !r.problem) };
  }, [caps, op, items]);
}

/** Make dropped files join the shared selection while this tool is showing. */
export function useDropIntoSelection() {
  const { add } = useSelection();
  useOnDrop(add);
}

/** Errors and warnings from the server's pre-check, shown before anything is uploaded. */
export function PreviewNotes({ preview, startError }: { preview: Preview; startError?: string | null }) {
  const names = (file: string | null) => (file ? <strong className="font-semibold">{file}: </strong> : null);
  return (
    <>
      {startError && (
        <Callout tone="error" title="Couldn't start">
          {startError}
        </Callout>
      )}
      {preview.failure && <Callout tone="error">{preview.failure}</Callout>}
      {preview.errors.length > 0 && (
        <Callout tone="error" title={preview.errors.length === 1 ? "Can't use this selection" : "Can't use these files"}>
          <ul>
            {preview.errors.map((e, i) => (
              <li key={i}>
                {names(e.file)}
                {e.message}
              </li>
            ))}
          </ul>
        </Callout>
      )}
      {preview.warnings.length > 0 && (
        <Callout tone="warning" title="Good to know">
          <ul>
            {preview.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Callout>
      )}
    </>
  );
}

/** Sticky bar with the main action at the bottom of a tool's form. */
export function ActionBar({ note, children }: { note?: ReactNode; children: ReactNode }) {
  return (
    <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white/95 px-5 py-3 shadow-lg backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
      <span className="text-sm text-slate-600 dark:text-slate-400">{note}</span>
      {children}
    </div>
  );
}

export { uploadName };
