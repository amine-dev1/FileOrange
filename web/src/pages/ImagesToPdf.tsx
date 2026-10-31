import { useMemo, useState } from "react";
import { ActionBar, PreviewNotes, ToolShell, useDropIntoSelection, useToolRows } from "../components/ToolShell";
import { FilesCard } from "../components/FilesCard";
import { Button, Card, Field, Segmented, TextInput } from "../components/ui";
import { extensionsFor, labels } from "../lib/capabilities";
import { formatBytes, plural } from "../lib/format";
import { toUploads, withExtension } from "../lib/run";
import { usePreview } from "../lib/usePreview";
import type { OperationReport, PageOrientation, PaperSize } from "../lib/types";
import { useCapabilities } from "../state/CapabilitiesProvider";
import { useJobs } from "../state/JobsProvider";
import { useSelection } from "../state/SelectionProvider";
import { t } from "../lib/i18n";

const MAX_MARGIN_MM = 50;

export function ImagesToPdfPage() {
  return (
    <ToolShell tool="images-to-pdf" opId="images_to_pdf" title={t("Images to PDF")} subtitle={t("Put pictures on PDF pages. Your originals are never changed.")}>
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
  const [name, setName] = useState("");
  const [paper, setPaper] = useState<PaperSize>("a4");
  const [orientation, setOrientation] = useState<PageOrientation>("auto");
  const [margin, setMargin] = useState("10");
  const marginMm = Number.parseFloat(margin);
  const marginOk = Number.isFinite(marginMm) && marginMm >= 0 && marginMm <= MAX_MARGIN_MM;
  const fixed = paper !== "fit";

  const options = useMemo(() => ({ paper, orientation: fixed ? orientation : "auto", margin_mm: fixed ? marginMm : 0, output_name: name.trim() || null }), [paper, orientation, fixed, marginMm, name]);
  const ready = valid && marginOk;
  const preview = usePreview(ready ? "images_to_pdf" : null, options, items);

  return (
    <>
      <FilesCard camera title={t("Pictures")} rows={rows} accept={extensionsFor(caps!, op.inputs)} hint={t("{formats} pictures. Each one becomes a page, in the order shown.", { formats: labels(caps!, op.inputs) })} noun="picture" addLabel={t("Add pictures")} orderNote={t("one page each, top to bottom")} />
      <Card title={t("Page layout")}>
        <div className="flex flex-col gap-5">
          <Segmented<PaperSize>
            label={t("Page size")}
            value={paper}
            onChange={setPaper}
            options={[
              { value: "a4", label: "A4" },
              { value: "letter", label: "Letter" },
              { value: "fit", label: "Same size as picture" },
            ]}
          />
          {fixed ? (
            <>
              <Segmented<PageOrientation>
                label={t("Orientation")}
                value={orientation}
                onChange={setOrientation}
                options={[
                  { value: "auto", label: "Automatic" },
                  { value: "portrait", label: "Portrait" },
                  { value: "landscape", label: "Landscape" },
                ]}
              />
              <Field label={t("Margin (mm)")} htmlFor="img-margin" hint={t("Space around each picture, 0 to {max}. Pictures are scaled to fit and never stretched.", { max: MAX_MARGIN_MM })}>
                <TextInput id="img-margin" type="number" min={0} max={MAX_MARGIN_MM} step={1} inputMode="decimal" value={margin} onChange={(e) => setMargin(e.target.value)} aria-invalid={!marginOk || undefined} className="max-w-40" />
              </Field>
            </>
          ) : (
            <p className="text-sm text-slate-600 dark:text-slate-400">{t("Each page takes the size of its picture, with no margin.")}</p>
          )}
          <Field label={t("File name")} htmlFor="img-name" hint={t("“.pdf” is added for you. Leave blank to name it after the first picture.")}>
            <TextInput id="img-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} spellCheck={false} className="sm:max-w-sm" />
          </Field>
        </div>
      </Card>
      <PreviewNotes preview={preview} />
      <ActionBar note={items.length ? `${plural(items.length, "picture")} · ${formatBytes(items.reduce((n, i) => n + i.size, 0))}` : "Add at least one picture."}>
        <Button
          variant="primary"
          disabled={!ready || !preview.ok || preview.loading}
          onClick={() => start({ tool: "images-to-pdf", operation: "images_to_pdf", options, files: toUploads(items), title: withExtension(name, "pdf", items.length === 1 ? items[0].name.replace(/\.[^.]+$/, "") : "images"), detail: plural(items.length, "picture") })}
        >
          {t("Create PDF")}
        </Button>
      </ActionBar>
    </>
  );
}
