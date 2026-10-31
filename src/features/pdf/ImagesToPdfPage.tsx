import { Plus } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { CapabilityGate } from "../../components/CapabilityGate";
import { DropZone } from "../../components/DropZone";
import { Field, Segmented, TextInput } from "../../components/Fields";
import { OutputFolder } from "../../components/OutputFolder";
import { useCapabilities } from "../../app/CapabilitiesProvider";
import { useDragging } from "../../app/DropProvider";
import { useSelection } from "../../app/SelectionProvider";
import { useSettings } from "../../app/SettingsProvider";
import { extensionsFor, labels } from "../../lib/capabilities";
import { dirname, formatBytes, plural } from "../../lib/format";
import type { ConflictPolicy, JobRequest, OperationReport, PageOrientation, PaperSize } from "../../lib/types";
import { dialogService } from "../../services/dialogService";
import { PreviewNotes } from "../workflow/PreviewNotes";
import { WorkflowPage } from "../workflow/WorkflowPage";
import { useReviewPreview } from "../workflow/useReviewPreview";
import { useRunFlow } from "../workflow/useRunFlow";
import { useWorkflowRows } from "../workflow/useWorkflowRows";
import { OrderedFileList } from "./OrderedFileList";
import "./pdf.css";

const MAX_MARGIN_MM = 50;

function ImagesForm({ op }: { op: OperationReport }) {
  const { caps } = useCapabilities();
  const { items, add, move, remove, clear, busy } = useSelection();
  const { settings } = useSettings();
  const dragging = useDragging();
  const { rows, valid } = useWorkflowRows(op.id, items);
  const [outputDir, setOutputDir] = useState<string | null>(settings.defaultOutputDir);
  const [name, setName] = useState("");
  const [paper, setPaper] = useState<PaperSize>("a4");
  const [orientation, setOrientation] = useState<PageOrientation>("auto");
  const [margin, setMargin] = useState("10");

  const marginMm = Number.parseFloat(margin);
  const marginOk = Number.isFinite(marginMm) && marginMm >= 0 && marginMm <= MAX_MARGIN_MM;
  const fits = paper !== "fit";

  const build = useCallback(
    (policy: ConflictPolicy): JobRequest | null =>
      items.length === 0 || !marginOk
        ? null
        : {
            inputs: items.map((i) => i.path),
            output_dir: outputDir ?? dirname(items[0].path),
            conflict: policy,
            operation: { type: "images_to_pdf", paper, orientation: fits ? orientation : "auto", margin_mm: fits ? marginMm : 0, output_name: name.trim() || null },
          },
    [items, marginOk, outputDir, paper, orientation, fits, marginMm, name],
  );
  const request = useMemo(() => (valid ? build("rename") : null), [valid, build]);
  const preview = useReviewPreview(request);
  const flow = useRunFlow({ kind: "images-to-pdf", inputs: items, actionLabel: "Create PDF", build });
  const blocked = !!preview.error || (preview.review?.errors.length ?? 0) > 0;
  const browse = async () => add(await dialogService.pickFiles([{ name: "Pictures", extensions: extensionsFor(caps!, op.inputs) }], "Choose pictures"));

  return (
    <>
      <Card title="Pictures">
        <div className="card-stack">
          {rows.length === 0 ? (
            <DropZone compact dragging={dragging} busy={busy} onBrowse={() => void browse()} hint={`${labels(caps!, op.inputs)} pictures. Each one becomes a page, in the order shown.`} />
          ) : (
            <>
              <OrderedFileList rows={rows} onMove={move} onRemove={remove} onClear={clear} noun="picture" orderNote="one page each, top to bottom" label="Pictures in page order" />
              <div className="action-bar" style={{ justifyContent: "flex-start" }}>
                <Button size="sm" icon={<Plus size={16} aria-hidden />} onClick={() => void browse()} disabled={busy}>
                  Add pictures
                </Button>
              </div>
            </>
          )}
        </div>
      </Card>
      <Card title="Page layout">
        <div className="options-grid">
          <Segmented<PaperSize>
            label="Page size"
            value={paper}
            onChange={setPaper}
            options={[
              { value: "a4", label: "A4" },
              { value: "letter", label: "Letter" },
              { value: "fit", label: "Same size as picture" },
            ]}
          />
          {fits && (
            <Segmented<PageOrientation>
              label="Orientation"
              value={orientation}
              onChange={setOrientation}
              options={[
                { value: "auto", label: "Automatic" },
                { value: "portrait", label: "Portrait" },
                { value: "landscape", label: "Landscape" },
              ]}
            />
          )}
          {fits && (
            <Field label="Margin (mm)" htmlFor="img-margin" hint={`Space around each picture, 0 to ${MAX_MARGIN_MM}. Pictures are scaled to fit and never stretched.`}>
              <TextInput id="img-margin" type="number" min={0} max={MAX_MARGIN_MM} step={1} inputMode="decimal" value={margin} onChange={(e) => setMargin(e.target.value)} aria-invalid={!marginOk || undefined} />
            </Field>
          )}
          {!fits && <p className="field__hint">Each page takes the size of its picture, with no margin.</p>}
          <Field label="File name" htmlFor="img-name" hint="“.pdf” is added for you. Leave blank to name it after the first picture.">
            <TextInput id="img-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} spellCheck={false} />
          </Field>
          <OutputFolder value={outputDir} onChange={setOutputDir} />
        </div>
      </Card>
      <PreviewNotes preview={preview} startError={flow.error} />
      <div className="action-bar action-bar--sticky">
        <span className="action-bar__note">{items.length > 0 ? `${plural(items.length, "picture")} · ${formatBytes(items.reduce((n, i) => n + i.size, 0))}` : "Add at least one picture."}</span>
        <Button variant="primary" onClick={() => void flow.begin()} disabled={!valid || !marginOk || flow.busy || blocked || preview.loading}>
          {flow.busy ? "Checking…" : "Create PDF"}
        </Button>
      </div>
      {flow.dialog}
    </>
  );
}

export function ImagesToPdfPage() {
  return (
    <WorkflowPage kind="images-to-pdf" title="Images to PDF" subtitle="Put pictures on PDF pages. Your originals are never changed.">
      <CapabilityGate operationId="images_to_pdf">{(op) => <ImagesForm op={op} />}</CapabilityGate>
    </WorkflowPage>
  );
}
