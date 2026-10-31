import { useCallback, useMemo, useState } from "react";
import { Card } from "../../components/Card";
import { Button } from "../../components/Button";
import { Field, Segmented } from "../../components/Fields";
import { OutputFolder } from "../../components/OutputFolder";
import { CapabilityGate } from "../../components/CapabilityGate";
import { WorkflowPage } from "../workflow/WorkflowPage";
import { FilesCard } from "../workflow/FilesCard";
import { OptionField } from "../workflow/OptionField";
import { PreviewNotes } from "../workflow/PreviewNotes";
import { useWorkflowRows } from "../workflow/useWorkflowRows";
import { useReviewPreview } from "../workflow/useReviewPreview";
import { useRunFlow } from "../workflow/useRunFlow";
import { useCapabilities } from "../../app/CapabilitiesProvider";
import { useNav } from "../../app/NavProvider";
import { useSelection } from "../../app/SelectionProvider";
import { useSettings } from "../../app/SettingsProvider";
import { dialogService } from "../../services/dialogService";
import { defaultOptionValues, extensionsFor, formatForFileName, formatLabel, labels, optionApplies, outputsForInputs } from "../../lib/capabilities";
import { dirname, plural } from "../../lib/format";
import type { ConflictPolicy, JobRequest, OperationReport } from "../../lib/types";

export function ConvertPage() {
  return (
    <WorkflowPage kind="convert" title="Convert" subtitle="Change files between formats. Originals are never changed.">
      <CapabilityGate operationId="convert_image">{(op) => <ConvertForm op={op} />}</CapabilityGate>
    </WorkflowPage>
  );
}

function ConvertForm({ op }: { op: OperationReport }) {
  const { caps } = useCapabilities();
  const { go } = useNav();
  const { items, add } = useSelection();
  const { settings } = useSettings();
  const { rows, valid } = useWorkflowRows(op.id, items);
  const [outputDir, setOutputDir] = useState<string | null>(settings.defaultOutputDir);
  const [picked, setPicked] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>(() => defaultOptionValues(op));

  // What the chosen files are (by name; the backend re-checks the real content)
  // decides which output formats are on offer.
  const inputFormats = useMemo(() => items.flatMap((i) => (caps && !i.is_dir ? [formatForFileName(caps, i.name)?.id ?? ""] : [])).filter(Boolean), [caps, items]);
  const reachable = useMemo(() => outputsForInputs(op, inputFormats), [op, inputFormats]);
  const format = picked && reachable.includes(picked) ? picked : (reachable[0] ?? null);
  const detail = useMemo(() => {
    if (!caps || !format || inputFormats.length === 0) return null;
    return `${[...new Set(inputFormats)].map((f) => formatLabel(caps, f)).join("/")} → ${formatLabel(caps, format)}`;
  }, [caps, format, inputFormats]);

  const build = useCallback(
    (policy: ConflictPolicy): JobRequest | null => {
      if (items.length === 0 || !format) return null;
      const send: Record<string, unknown> = {};
      for (const o of op.options) if (optionApplies(o, format, values) && values[o.id] !== undefined) send[o.id] = values[o.id];
      return {
        inputs: items.map((i) => i.path),
        output_dir: outputDir ?? dirname(items[0].path),
        conflict: policy,
        operation: { type: "convert_image", format, ...send } as JobRequest["operation"],
      };
    },
    [items, format, op.options, values, outputDir],
  );
  const request = useMemo(() => (valid ? build("rename") : null), [valid, build]);
  const preview = useReviewPreview(request);
  const flow = useRunFlow({ kind: "convert", inputs: items, detail, actionLabel: "Convert", build });
  const blocked = !!preview.error || (preview.review?.errors.length ?? 0) > 0;
  const sameFormat = format !== null && inputFormats.length > 0 && inputFormats.every((f) => f === format);

  return (
    <>
      <FilesCard
        rows={rows}
        hint={labels(caps!, op.inputs)}
        onBrowse={async () => add(await dialogService.pickFiles([{ name: "Supported files", extensions: extensionsFor(caps!, op.inputs) }], "Choose files to convert"))}
      />
      <Card title="Options">
        <div className="options-grid">
          <Field label="Convert to">
            <Segmented
              label="Output format"
              value={format ?? ""}
              onChange={setPicked}
              options={op.outputs.map((id) => ({
                value: id,
                label: formatLabel(caps!, id),
                disabled: !reachable.includes(id),
                reason: `Not every selected file can be converted to ${formatLabel(caps!, id)}.`,
              }))}
            />
            {sameFormat && <p className="field__hint">Your files are already {formatLabel(caps!, format!)}. This makes re-encoded copies, which is useful for removing photo information or changing quality.</p>}
            {items.length > 0 && reachable.length === 0 && <p className="field__hint">These files can't all be converted to the same format. Convert them in separate batches.</p>}
          </Field>
          {format &&
            op.options
              .filter((o) => optionApplies(o, format, values))
              .map((o) => <OptionField key={o.id} spec={o} value={values[o.id]} onChange={(v) => setValues((s) => ({ ...s, [o.id]: v }))} />)}
          <OutputFolder value={outputDir} onChange={setOutputDir} />
          <div>
            <button className="link-btn link-btn--flush" onClick={() => go("formats")}>
              See every supported conversion
            </button>
          </div>
        </div>
      </Card>
      <PreviewNotes preview={preview} startError={flow.error} />
      <div className="action-bar action-bar--sticky">
        <span className="action-bar__note">{items.length > 0 ? plural(items.length, "file") : "Add at least one file."}</span>
        <Button variant="primary" onClick={() => void flow.begin()} disabled={!valid || !format || flow.busy || blocked || preview.loading}>
          {flow.busy ? "Checking…" : "Convert"}
        </Button>
      </div>
      {flow.dialog}
    </>
  );
}

