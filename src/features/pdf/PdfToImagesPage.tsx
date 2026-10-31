import { useCallback, useMemo, useState } from "react";
import { Callout } from "../../components/Callout";
import { Card } from "../../components/Card";
import { CapabilityGate } from "../../components/CapabilityGate";
import { Button } from "../../components/Button";
import { Field, Segmented, Slider, TextInput } from "../../components/Fields";
import { OutputFolder } from "../../components/OutputFolder";
import { useCapabilities } from "../../app/CapabilitiesProvider";
import { useSelection } from "../../app/SelectionProvider";
import { useSettings } from "../../app/SettingsProvider";
import { extensionsFor, formatLabel } from "../../lib/capabilities";
import { dirname } from "../../lib/format";
import type { ConflictPolicy, JobRequest, OperationReport } from "../../lib/types";
import { dialogService } from "../../services/dialogService";
import { FilesCard } from "../workflow/FilesCard";
import { PreviewNotes } from "../workflow/PreviewNotes";
import { WorkflowPage } from "../workflow/WorkflowPage";
import { useReviewPreview } from "../workflow/useReviewPreview";
import { useRunFlow } from "../workflow/useRunFlow";
import { useWorkflowRows } from "../workflow/useWorkflowRows";
import "./pdf.css";

type Format = "png" | "jpeg" | "webp";
type Which = "all" | "some";

const DPI_CHOICES = [
  { value: "72", label: "72 · screen" },
  { value: "150", label: "150 · standard" },
  { value: "300", label: "300 · print" },
  { value: "600", label: "600 · very large" },
];
const MIN_DPI = 36;
const MAX_DPI = 600;

function ImagesForm({ op }: { op: OperationReport }) {
  const { caps } = useCapabilities();
  const { items, add } = useSelection();
  const { settings } = useSettings();
  const { rows, valid } = useWorkflowRows(op.id, items);
  const [outputDir, setOutputDir] = useState<string | null>(settings.defaultOutputDir);
  const outputs = op.outputs as Format[];
  const [format, setFormat] = useState<Format>(outputs.includes("png") ? "png" : outputs[0]);
  const [dpiText, setDpiText] = useState("150");
  const [which, setWhich] = useState<Which>("all");
  const [pages, setPages] = useState("");
  const [quality, setQuality] = useState(90);
  const [password, setPassword] = useState("");

  const dpi = Number.parseInt(dpiText, 10);
  const dpiOk = Number.isFinite(dpi) && dpi >= MIN_DPI && dpi <= MAX_DPI;
  const pagesOk = which === "all" || pages.trim().length > 0;
  const lossy = format !== "png";

  const build = useCallback(
    (policy: ConflictPolicy): JobRequest | null =>
      items.length === 0 || !dpiOk || !pagesOk
        ? null
        : {
            inputs: items.map((i) => i.path),
            output_dir: outputDir ?? dirname(items[0].path),
            conflict: policy,
            operation: { type: "pdf_to_images", format, dpi, pages: which === "some" ? pages.trim() : null, ...(lossy ? { quality } : {}), password: password || null },
          },
    [items, dpiOk, pagesOk, outputDir, format, dpi, which, pages, lossy, quality, password],
  );
  const request = useMemo(() => (valid ? build("rename") : null), [valid, build]);
  const preview = useReviewPreview(request);
  const detail = caps ? `${formatLabel(caps, format)}, ${dpi} dpi` : null;
  const flow = useRunFlow({ kind: "pdf-to-images", inputs: items, detail, actionLabel: "Save images", build });
  const blocked = !!preview.error || (preview.review?.errors.length ?? 0) > 0;
  const needsPassword = preview.review?.needs_password && !password;

  return (
    <>
      <FilesCard
        title="PDFs to save as images"
        rows={rows}
        hint="Choose one or more PDFs"
        addLabel="Add PDFs"
        onBrowse={async () => add(await dialogService.pickFiles([{ name: "PDF files", extensions: extensionsFor(caps!, op.inputs) }], "Choose PDFs"))}
      />
      <Card title="Options">
        <div className="options-grid">
          <Segmented<Format>
            label="Image format"
            value={format}
            onChange={setFormat}
            options={outputs.map((f) => ({ value: f, label: formatLabel(caps!, f) }))}
          />
          <Field label="Resolution (dots per inch)" htmlFor="pti-dpi" hint={`${MIN_DPI} to ${MAX_DPI}. Higher is sharper and makes bigger files. Very large pages may be saved a little smaller; you'll be told.`}>
            <div className="pti-dpi">
              <TextInput id="pti-dpi" type="number" min={MIN_DPI} max={MAX_DPI} inputMode="numeric" value={dpiText} onChange={(e) => setDpiText(e.target.value)} aria-invalid={!dpiOk || undefined} />
              <Segmented<string> label="Resolution presets" value={DPI_CHOICES.some((c) => c.value === dpiText) ? dpiText : ""} onChange={setDpiText} options={DPI_CHOICES} />
            </div>
          </Field>
          {lossy && (
            <Field label="Quality" htmlFor="pti-quality" hint="Lower makes smaller files with a little less detail.">
              <Slider id="pti-quality" label="Quality" value={quality} min={10} max={100} onChange={setQuality} />
            </Field>
          )}
          <Segmented<Which>
            label="Pages"
            value={which}
            onChange={setWhich}
            options={[
              { value: "all", label: "All pages" },
              { value: "some", label: "Choose pages" },
            ]}
          />
          {which === "some" && (
            <Field label="Which pages" htmlFor="pti-pages" hint="For example 1-3, 5, 8-. A dash at the end means “to the last page”. Applies to every PDF.">
              <TextInput id="pti-pages" value={pages} onChange={(e) => setPages(e.target.value)} placeholder="1-3, 5, 8-" spellCheck={false} aria-invalid={!pagesOk || undefined} />
            </Field>
          )}
          <OutputFolder value={outputDir} onChange={setOutputDir} />
          <Field label={needsPassword ? "Password (needed for this PDF)" : "Password (only if a PDF needs one)"} htmlFor="pti-password" hint="Used for this job only and never saved.">
            <TextInput id="pti-password" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        </div>
      </Card>
      <Callout tone="info">Each PDF gets its own folder next to where you save, holding one picture per page, like “report - page 01.png”.</Callout>
      <PreviewNotes preview={preview} startError={flow.error} />
      <div className="action-bar action-bar--sticky">
        <span className="action-bar__note">{items.length === 0 ? "Choose a PDF." : !dpiOk ? `Resolution must be between ${MIN_DPI} and ${MAX_DPI}.` : !pagesOk ? "Enter the pages to save." : ""}</span>
        <Button variant="primary" onClick={() => void flow.begin()} disabled={!valid || !dpiOk || !pagesOk || flow.busy || blocked || !!needsPassword || preview.loading}>
          {flow.busy ? "Checking…" : "Save images"}
        </Button>
      </div>
      {flow.dialog}
    </>
  );
}

export function PdfToImagesPage() {
  return (
    <WorkflowPage kind="pdf-to-images" title="PDF to images" subtitle="Save PDF pages as PNG, JPG or WebP pictures. Your PDF is never changed.">
      <CapabilityGate operationId="pdf_to_images">{(op) => <ImagesForm op={op} />}</CapabilityGate>
    </WorkflowPage>
  );
}
