import { useMemo, useState } from "react";
import { ActionBar, PreviewNotes, ToolShell, useDropIntoSelection, useToolRows } from "../components/ToolShell";
import { FilesCard } from "../components/FilesCard";
import { PasswordField } from "../components/PasswordField";
import { Button, Callout, Card, Field, Segmented, Slider, TextInput } from "../components/ui";
import { extensionsFor, formatLabel } from "../lib/capabilities";
import { toUploads } from "../lib/run";
import { usePreview } from "../lib/usePreview";
import type { OperationReport } from "../lib/types";
import { useCapabilities } from "../state/CapabilitiesProvider";
import { useJobs } from "../state/JobsProvider";
import { useSelection } from "../state/SelectionProvider";
import { t } from "../lib/i18n";

type Format = "png" | "jpeg" | "webp";
type Which = "all" | "some";
const MIN_DPI = 36;
const MAX_DPI = 600;
const PRESETS = [
  { value: "72", label: "72 · screen" },
  { value: "150", label: "150 · standard" },
  { value: "300", label: "300 · print" },
  { value: "600", label: "600 · very large" },
];

export function PdfToImagesPage() {
  return (
    <ToolShell tool="pdf-to-images" opId="pdf_to_images" title={t("PDF to images")} subtitle={t("Save PDF pages as PNG, JPG or WebP pictures. Your PDF is never changed.")}>
      {(op) => <Form op={op} />}
    </ToolShell>
  );
}

function Form({ op }: { op: OperationReport }) {
  const { caps } = useCapabilities();
  const { items } = useSelection();
  const { start } = useJobs();
  useDropIntoSelection();
  const { rows, valid } = useToolRows(op, items);
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
  const options = useMemo(() => ({ format, dpi, pages: which === "some" ? pages.trim() : null, ...(lossy ? { quality } : {}), password: password || null }), [format, dpi, which, pages, lossy, quality, password]);
  const ready = valid && dpiOk && pagesOk;
  const preview = usePreview(ready ? "pdf_to_images" : null, options, items);

  return (
    <>
      <FilesCard title={t("PDFs to save as images")} rows={rows} accept={extensionsFor(caps!, op.inputs)} hint={t("Choose one or more PDFs")} noun="PDF" addLabel={t("Add PDFs")} />
      <Card title={t("Options")}>
        <div className="flex flex-col gap-5">
          <Segmented<Format> label={t("Image format")} value={format} onChange={setFormat} options={outputs.map((f) => ({ value: f, label: formatLabel(caps!, f) }))} />
          <Field label={t("Resolution (dots per inch)")} htmlFor="pti-dpi" hint={t("{min} to {max}. Higher is sharper and makes bigger files. Very large pages may be saved a little smaller; you'll be told.", { min: MIN_DPI, max: MAX_DPI })}>
            <div className="flex flex-col gap-2">
              <TextInput id="pti-dpi" type="number" min={MIN_DPI} max={MAX_DPI} inputMode="numeric" value={dpiText} onChange={(e) => setDpiText(e.target.value)} aria-invalid={!dpiOk || undefined} className="max-w-40" />
              <Segmented<string> label={t("Resolution presets")} value={PRESETS.some((p) => p.value === dpiText) ? dpiText : ""} onChange={setDpiText} options={PRESETS} />
            </div>
          </Field>
          {lossy && (
            <Field label={t("Quality")} htmlFor="pti-quality" hint={t("Lower makes smaller files with a little less detail.")}>
              <Slider id="pti-quality" label={t("Quality")} value={quality} min={10} max={100} onChange={setQuality} />
            </Field>
          )}
          <Segmented<Which>
            label={t("Pages")}
            value={which}
            onChange={setWhich}
            options={[
              { value: "all", label: "All pages" },
              { value: "some", label: "Choose pages" },
            ]}
          />
          {which === "some" && (
            <Field label={t("Which pages")} htmlFor="pti-pages" hint={t("For example 1-3, 5, 8-. A dash at the end means “to the last page”. Applies to every PDF.")}>
              <TextInput id="pti-pages" value={pages} onChange={(e) => setPages(e.target.value)} placeholder="1-3, 5, 8-" spellCheck={false} className="max-w-xs" />
            </Field>
          )}
          <PasswordField id="pti-password" value={password} onChange={setPassword} />
        </div>
      </Card>
      <Callout tone="info">{t("Each PDF gets its own folder in the result, holding one picture per page, like “report - page 01.png”. Several pictures come as a ZIP.")}</Callout>
      <PreviewNotes preview={preview} />
      <ActionBar note={items.length === 0 ? "Choose a PDF." : !dpiOk ? t("Resolution must be between {min} and {max}.", { min: MIN_DPI, max: MAX_DPI }) : !pagesOk ? "Enter the pages to save." : ""}>
        <Button variant="primary" disabled={!ready || !preview.ok || preview.loading} onClick={() => start({ tool: "pdf-to-images", operation: "pdf_to_images", options, files: toUploads(items), title: items.length === 1 ? items[0].name : `${items[0].name} +${items.length - 1} more`, detail: `${formatLabel(caps!, format)}, ${dpi} dpi` })}>
          {t("Save images")}
        </Button>
      </ActionBar>
    </>
  );
}
