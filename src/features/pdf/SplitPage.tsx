import { useCallback, useMemo, useState } from "react";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { CapabilityGate } from "../../components/CapabilityGate";
import { Field, Segmented, TextInput } from "../../components/Fields";
import { OutputFolder } from "../../components/OutputFolder";
import { useCapabilities } from "../../app/CapabilitiesProvider";
import { useSelection } from "../../app/SelectionProvider";
import { useSettings } from "../../app/SettingsProvider";
import { extensionsFor } from "../../lib/capabilities";
import { dirname } from "../../lib/format";
import type { ConflictPolicy, JobRequest } from "../../lib/types";
import { dialogService } from "../../services/dialogService";
import { FilesCard } from "../workflow/FilesCard";
import { PreviewNotes } from "../workflow/PreviewNotes";
import { WorkflowPage } from "../workflow/WorkflowPage";
import { useReviewPreview } from "../workflow/useReviewPreview";
import { useRunFlow } from "../workflow/useRunFlow";
import { useWorkflowRows } from "../workflow/useWorkflowRows";
import "./pdf.css";

type Mode = "every" | "ranges";

function SplitForm() {
  const { caps } = useCapabilities();
  const { items, add } = useSelection();
  const { settings } = useSettings();
  const base = useWorkflowRows("pdf_split", items);
  // Split works on one file; the extra ones are marked so the reason is on screen.
  const rows = base.rows.map((r, i) => (i > 0 && !r.problem ? { ...r, problem: "Split works on one PDF at a time. Remove this one." } : r));
  const valid = base.valid && items.length === 1;
  const [outputDir, setOutputDir] = useState<string | null>(settings.defaultOutputDir);
  const [mode, setMode] = useState<Mode>("every");
  const [every, setEvery] = useState("1");
  const [ranges, setRanges] = useState("");
  const [password, setPassword] = useState("");

  const everyN = Number.parseInt(every, 10);
  const inputOk = mode === "every" ? Number.isFinite(everyN) && everyN >= 1 : ranges.trim().length > 0;

  const build = useCallback(
    (policy: ConflictPolicy): JobRequest | null =>
      items.length !== 1 || !inputOk
        ? null
        : {
            inputs: [items[0].path],
            output_dir: outputDir ?? dirname(items[0].path),
            conflict: policy,
            operation: mode === "every" ? { type: "pdf_split", mode, every: everyN, password: password || null } : { type: "pdf_split", mode, ranges, password: password || null },
          },
    [items, inputOk, outputDir, mode, everyN, ranges, password],
  );
  const request = useMemo(() => build("rename"), [build]);
  const preview = useReviewPreview(request);
  const flow = useRunFlow({ kind: "pdf-split", inputs: items.slice(0, 1), detail: mode === "every" ? `every ${everyN}` : "ranges", actionLabel: "Split", build });
  const blocked = !!preview.error || (preview.review?.errors.length ?? 0) > 0;
  const needsPassword = preview.review?.needs_password && !password;

  return (
    <>
      <FilesCard
        title="PDF to split"
        rows={rows}
        hint="Choose one PDF"
        addLabel="Choose another PDF"
        onBrowse={async () => add(await dialogService.pickFiles([{ name: "PDF files", extensions: extensionsFor(caps!, ["pdf"]) }], "Choose a PDF to split"))}
      />
      <Card title="Options">
        <div className="options-grid">
          <Segmented<Mode>
            label="Split by"
            value={mode}
            onChange={setMode}
            options={[
              { value: "every", label: "Pages per file" },
              { value: "ranges", label: "Page ranges" },
            ]}
          />
          {mode === "every" ? (
            <Field label="Pages in each new PDF" htmlFor="split-every" hint="1 makes one PDF per page. The last one holds whatever is left.">
              <TextInput id="split-every" type="number" min={1} max={50000} inputMode="numeric" value={every} onChange={(e) => setEvery(e.target.value)} aria-invalid={!inputOk || undefined} />
            </Field>
          ) : (
            <Field label="Page ranges" htmlFor="split-ranges" hint="One new PDF for each range, for example 1-3, 4, 7-. A dash at the end means “to the last page”.">
              <TextInput id="split-ranges" value={ranges} onChange={(e) => setRanges(e.target.value)} placeholder="1-3, 4, 7-" spellCheck={false} aria-invalid={(ranges.trim().length > 0 && !inputOk) || undefined} />
            </Field>
          )}
          <OutputFolder value={outputDir} onChange={setOutputDir} />
          <Field label={needsPassword ? "Password (needed for this PDF)" : "Password (only if the PDF needs one)"} htmlFor="split-password" hint="Used for this job only and never saved. The new PDFs are not protected.">
            <TextInput id="split-password" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        </div>
      </Card>
      <PreviewNotes preview={preview} startError={flow.error} />
      <div className="action-bar action-bar--sticky">
        <span className="action-bar__note">{items.length === 0 ? "Choose a PDF." : !inputOk ? (mode === "every" ? "Enter how many pages each file should have." : "Enter the page ranges.") : "The new PDFs go in a folder next to where you save."}</span>
        <Button variant="primary" onClick={() => void flow.begin()} disabled={!valid || !inputOk || flow.busy || blocked || !!needsPassword || preview.loading}>
          {flow.busy ? "Checking…" : "Split"}
        </Button>
      </div>
      {flow.dialog}
    </>
  );
}

export function SplitPage() {
  return (
    <WorkflowPage kind="pdf-split" title="Split PDF" subtitle="Cut one PDF into several. Your original is never changed.">
      <CapabilityGate operationId="pdf_split">{() => <SplitForm />}</CapabilityGate>
    </WorkflowPage>
  );
}
