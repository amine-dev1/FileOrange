import { Plus } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { CapabilityGate } from "../../components/CapabilityGate";
import { DropZone } from "../../components/DropZone";
import { Field, TextInput } from "../../components/Fields";
import { OutputFolder } from "../../components/OutputFolder";
import { useCapabilities } from "../../app/CapabilitiesProvider";
import { useDragging } from "../../app/DropProvider";
import { useSelection } from "../../app/SelectionProvider";
import { useSettings } from "../../app/SettingsProvider";
import { extensionsFor } from "../../lib/capabilities";
import { dirname, formatBytes, plural } from "../../lib/format";
import type { ConflictPolicy, JobRequest } from "../../lib/types";
import { dialogService } from "../../services/dialogService";
import { PreviewNotes } from "../workflow/PreviewNotes";
import { WorkflowPage } from "../workflow/WorkflowPage";
import { useReviewPreview } from "../workflow/useReviewPreview";
import { useRunFlow } from "../workflow/useRunFlow";
import { useWorkflowRows } from "../workflow/useWorkflowRows";
import { OrderedFileList } from "./OrderedFileList";
import "./pdf.css";

function MergeForm() {
  const { caps } = useCapabilities();
  const { items, add, move, remove, clear, busy } = useSelection();
  const { settings } = useSettings();
  const dragging = useDragging();
  const { rows, valid } = useWorkflowRows("pdf_merge", items);
  const [outputDir, setOutputDir] = useState<string | null>(settings.defaultOutputDir);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");

  const build = useCallback(
    (policy: ConflictPolicy): JobRequest | null =>
      items.length < 2
        ? null
        : {
            inputs: items.map((i) => i.path),
            output_dir: outputDir ?? dirname(items[0].path),
            conflict: policy,
            operation: { type: "pdf_merge", output_name: name.trim() || null, password: password || null },
          },
    [items, outputDir, name, password],
  );
  const request = useMemo(() => build("rename"), [build]);
  const preview = useReviewPreview(request);
  const flow = useRunFlow({ kind: "pdf-merge", inputs: items, actionLabel: "Merge", build });
  const blocked = !!preview.error || (preview.review?.errors.length ?? 0) > 0;
  const browse = async () => add(await dialogService.pickFiles([{ name: "PDF files", extensions: extensionsFor(caps!, ["pdf"]) }], "Choose PDFs to merge"));

  return (
    <>
      <Card title="PDFs to merge">
        <div className="card-stack">
          {rows.length === 0 ? (
            <DropZone compact dragging={dragging} busy={busy} onBrowse={() => void browse()} hint="Choose two or more PDFs. They are joined in the order shown." />
          ) : (
            <>
              <OrderedFileList rows={rows} onMove={move} onRemove={remove} onClear={clear} />
              <div className="action-bar" style={{ justifyContent: "flex-start" }}>
                <Button size="sm" icon={<Plus size={16} aria-hidden />} onClick={() => void browse()} disabled={busy}>
                  Add PDFs
                </Button>
                {items.length < 2 && <span className="action-bar__note">Add at least one more PDF.</span>}
              </div>
            </>
          )}
        </div>
      </Card>
      <Card title="Options">
        <div className="options-grid">
          <Field label="File name" htmlFor="merge-name" hint="“.pdf” is added for you. Leave blank for “merged”.">
            <TextInput id="merge-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="merged" maxLength={120} spellCheck={false} />
          </Field>
          <OutputFolder value={outputDir} onChange={setOutputDir} />
          <Field label="Password (only if a PDF needs one)" htmlFor="merge-password" hint="Tried on every protected PDF. Used for this job only and never saved. The merged PDF is not protected.">
            <TextInput id="merge-password" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        </div>
      </Card>
      <PreviewNotes preview={preview} startError={flow.error} />
      <div className="action-bar action-bar--sticky">
        <span className="action-bar__note">{items.length > 0 ? `${plural(items.length, "PDF")} · ${formatBytes(items.reduce((n, i) => n + i.size, 0))}` : "Add at least two PDFs."}</span>
        <Button variant="primary" onClick={() => void flow.begin()} disabled={!valid || items.length < 2 || flow.busy || blocked || preview.loading}>
          {flow.busy ? "Checking…" : "Merge"}
        </Button>
      </div>
      {flow.dialog}
    </>
  );
}

export function MergePage() {
  return (
    <WorkflowPage kind="pdf-merge" title="Merge PDFs" subtitle="Combine several PDFs into one. Your originals are never changed.">
      <CapabilityGate operationId="pdf_merge">{() => <MergeForm />}</CapabilityGate>
    </WorkflowPage>
  );
}
