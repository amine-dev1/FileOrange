import "./ExtractPage.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Lock, ShieldAlert } from "lucide-react";
import { Card } from "../../components/Card";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { Field, TextInput, Toggle } from "../../components/Fields";
import { OutputFolder } from "../../components/OutputFolder";
import { WorkflowPage } from "../workflow/WorkflowPage";
import { FilesCard } from "../workflow/FilesCard";
import { PreviewNotes } from "../workflow/PreviewNotes";
import { useWorkflowRows } from "../workflow/useWorkflowRows";
import { useReviewPreview } from "../workflow/useReviewPreview";
import { useRunFlow } from "../workflow/useRunFlow";
import { useSelection } from "../../app/SelectionProvider";
import { useSettings } from "../../app/SettingsProvider";
import { dialogService } from "../../services/dialogService";
import { jobsService } from "../../services/jobsService";
import { messageOf } from "../../lib/tauri";
import { dirname, formatBytes, plural } from "../../lib/format";
import { extensionsFor, labels } from "../../lib/capabilities";
import { useCapabilities } from "../../app/CapabilitiesProvider";
import { CapabilityGate } from "../../components/CapabilityGate";
import type { ArchiveListing, ConflictPolicy, JobRequest, OperationReport, PathInfo } from "../../lib/types";

/** A path with no entry yet is still being read. */
type Detail = { state: "ok"; listing: ArchiveListing } | { state: "error"; message: string };

function useArchiveDetails(items: PathInfo[]) {
  const [details, setDetails] = useState<Record<string, Detail>>({});
  const requested = useRef(new Set<string>());
  useEffect(() => {
    for (const it of items) {
      if (requested.current.has(it.path)) continue;
      requested.current.add(it.path);
      jobsService
        .listArchive(it.path)
        .then((listing) => setDetails((d) => ({ ...d, [it.path]: { state: "ok", listing } })))
        .catch((e) => setDetails((d) => ({ ...d, [it.path]: { state: "error", message: messageOf(e) } })));
    }
  }, [items]);
  return details;
}

function ExtractForm({ op }: { op: OperationReport }) {
  const { caps } = useCapabilities();
  const { items, add } = useSelection();
  const { settings } = useSettings();
  const details = useArchiveDetails(items);
  const base = useWorkflowRows(op.id, items);
  const [outputDir, setOutputDir] = useState<string | null>(settings.defaultOutputDir);
  const [subfolder, setSubfolder] = useState(true);
  const [password, setPassword] = useState("");

  const rows = useMemo(
    () =>
      base.rows.map((r) => {
        const d = details[r.info.path];
        if (!r.problem && d?.state === "error") return { ...r, problem: `${d.message} Remove it to continue.` };
        return r;
      }),
    [base.rows, details],
  );
  const listings = items.map((i) => details[i.path]).flatMap((d) => (d?.state === "ok" ? [d.listing] : []));
  const loading = items.some((i) => !details[i.path]);
  const needsPassword = listings.some((l) => l.needs_password);
  const unsafe = listings.some((l) => l.unsafe_entries > 0);
  const valid = base.valid && rows.every((r) => !r.problem) && !loading;

  const build = useCallback(
    (policy: ConflictPolicy): JobRequest | null =>
      items.length === 0
        ? null
        : {
            inputs: items.map((i) => i.path),
            output_dir: outputDir ?? dirname(items[0].path),
            conflict: policy,
            operation: { type: "extract", password: needsPassword ? password : null, subfolder },
          },
    [items, outputDir, subfolder, needsPassword, password],
  );
  const request = useMemo(() => (valid ? build("rename") : null), [valid, build]);
  const preview = useReviewPreview(request);
  const flow = useRunFlow({ kind: "extract", inputs: items, actionLabel: "Extract", build });
  const blocked = !!preview.error || (preview.review?.errors.length ?? 0) > 0 || unsafe;
  const passwordMissing = needsPassword && password.length === 0;

  return (
    <>
      <FilesCard
        title="Archives"
        rows={rows}
        hint={labels(caps!, op.inputs)}
        addLabel="Add archives"
        onBrowse={async () => add(await dialogService.pickFiles([{ name: "Archives", extensions: extensionsFor(caps!, op.inputs) }], "Choose archives to extract"))}
      >
        {listings.length > 0 && (
          <ul className="archive-details" aria-label="Archive details">
            {items.map((i) => {
              const d = details[i.path];
              if (d?.state !== "ok") return null;
              const l = d.listing;
              return (
                <li key={i.path}>
                  <strong>{i.name}</strong>
                  <span>
                    {plural(l.file_count, "file")} · {formatBytes(l.total_uncompressed)} when extracted
                  </span>
                  {l.needs_password && (
                    <span className="tag">
                      <Lock size={13} aria-hidden /> Password protected
                    </span>
                  )}
                  {l.unsafe_entries > 0 && (
                    <span className="tag tag--bad">
                      <ShieldAlert size={13} aria-hidden /> Unsafe paths
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </FilesCard>
      <Card title="Options">
        <div className="options-grid">
          <OutputFolder label="Extract to" value={outputDir} onChange={setOutputDir} />
          <Toggle id="subfolder" checked={subfolder} onChange={setSubfolder} label="Put files in a folder named after the archive" description="Keeps the contents of each archive tidy and separate." />
          {needsPassword && (
            <Field label="Password" htmlFor="archive-password" hint="Used only for this job. It is never saved.">
              <TextInput id="archive-password" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
          )}
        </div>
      </Card>
      {unsafe && (
        <Callout tone="error" title="This archive isn't safe to extract">
          It contains paths that would write outside the destination folder, so OrangeFile won't extract it.
        </Callout>
      )}
      <PreviewNotes preview={preview} startError={flow.error} />
      <div className="action-bar action-bar--sticky">
        <span className="action-bar__note">{loading ? "Reading archives…" : items.length > 0 ? plural(items.length, "archive") : "Add at least one archive."}</span>
        <Button variant="primary" onClick={() => void flow.begin()} disabled={!valid || flow.busy || blocked || passwordMissing || preview.loading}>
          {flow.busy ? "Checking…" : "Extract"}
        </Button>
      </div>
      {flow.dialog}
    </>
  );
}

export function ExtractPage() {
  return (
    <WorkflowPage kind="extract" title="Extract" subtitle="Open archives into a folder you choose.">
      <CapabilityGate operationId="extract">{(op) => <ExtractForm op={op} />}</CapabilityGate>
    </WorkflowPage>
  );
}
