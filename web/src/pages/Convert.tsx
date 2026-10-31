import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ActionBar, PreviewNotes, ToolShell, useDropIntoSelection, useToolRows } from "../components/ToolShell";
import { FilesCard } from "../components/FilesCard";
import { OptionField } from "../components/OptionField";
import { Button, Card, Segmented } from "../components/ui";
import { defaultOptionValues, extensionsFor, formatForFileName, formatLabel, labels, optionApplies, outputsForInputs } from "../lib/capabilities";
import { plural } from "../lib/format";
import { titleFor, toUploads } from "../lib/run";
import { usePreview } from "../lib/usePreview";
import type { OperationReport } from "../lib/types";
import { useCapabilities } from "../state/CapabilitiesProvider";
import { useJobs } from "../state/JobsProvider";
import { useSelection } from "../state/SelectionProvider";
import { t } from "../lib/i18n";

export function ConvertPage() {
  return (
    <ToolShell tool="convert" opId="convert_image" title={t("Convert images")} subtitle={t("Change pictures between formats. Your originals are never changed.")}>
      {(op) => <ConvertForm op={op} />}
    </ToolShell>
  );
}

function ConvertForm({ op }: { op: OperationReport }) {
  const { caps } = useCapabilities();
  const { items } = useSelection();
  const { start } = useJobs();
  useDropIntoSelection();
  const { rows, valid } = useToolRows(op, items);
  const [picked, setPicked] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>(() => defaultOptionValues(op));

  // What the files are (by name here; the server re-checks the real content) decides which outputs are on offer.
  const inputFormats = useMemo(() => items.map((i) => (caps ? (formatForFileName(caps, i.name)?.id ?? "") : "")).filter(Boolean), [caps, items]);
  const reachable = useMemo(() => outputsForInputs(op, inputFormats), [op, inputFormats]);
  const format = picked && reachable.includes(picked) ? picked : (reachable[0] ?? null);
  const options = useMemo(() => {
    if (!format) return null;
    const send: Record<string, unknown> = { format };
    for (const o of op.options) if (optionApplies(o, format, values) && values[o.id] !== undefined) send[o.id] = values[o.id];
    return send;
  }, [format, op.options, values]);

  const preview = usePreview(valid && options ? "convert" : null, options, items);
  const sameFormat = format !== null && inputFormats.length > 0 && inputFormats.every((f) => f === format);
  const detail = caps && format && inputFormats.length ? `${[...new Set(inputFormats)].map((f) => formatLabel(caps, f)).join("/")} → ${formatLabel(caps, format)}` : null;

  const run = () =>
    options &&
    start({ tool: "convert", operation: "convert", options, files: toUploads(items), title: titleFor(items), detail });

  return (
    <>
      <FilesCard camera rows={rows} accept={extensionsFor(caps!, op.inputs)} hint={t("{formats} pictures", { formats: labels(caps!, op.inputs) })} noun="picture" />
      <Card title={t("Options")}>
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <Segmented
              label={t("Convert to")}
              value={format ?? ""}
              onChange={setPicked}
              options={op.outputs.map((id) => ({ value: id, label: formatLabel(caps!, id), disabled: !reachable.includes(id), reason: t("Not every selected file can be converted to {format}.", { format: formatLabel(caps!, id) }) }))}
            />
            {sameFormat && <p className="text-xs text-slate-600 dark:text-slate-400">{t("Your files are already {format}. This makes re-encoded copies, which is useful for removing photo information or changing quality.", { format: formatLabel(caps!, format!) })}</p>}
            {items.length > 0 && reachable.length === 0 && <p className="text-xs text-red-700 dark:text-red-300">{t("These files can't all be converted to the same format. Convert them in separate batches.")}</p>}
          </div>
          {format && op.options.filter((o) => optionApplies(o, format, values)).map((o) => <OptionField key={o.id} spec={o} value={values[o.id]} onChange={(v) => setValues((s) => ({ ...s, [o.id]: v }))} />)}
          <p className="text-sm">
            <Link to="/about" className="font-medium text-brand-700 underline-offset-2 hover:underline dark:text-brand-300">
              {t("See every supported conversion")}
            </Link>
          </p>
        </div>
      </Card>
      <PreviewNotes preview={preview} />
      <ActionBar note={items.length ? plural(items.length, "file") : "Add at least one picture."}>
        <Button variant="primary" onClick={run} disabled={!valid || !format || !preview.ok || preview.loading}>
          {t("Convert")}
        </Button>
      </ActionBar>
    </>
  );
}
