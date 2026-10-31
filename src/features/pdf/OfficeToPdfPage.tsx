import { useCallback, useMemo, useState } from "react";
import { Card } from "../../components/Card";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { CapabilityGate } from "../../components/CapabilityGate";
import { OutputFolder } from "../../components/OutputFolder";
import { useCapabilities } from "../../app/CapabilitiesProvider";
import { useSelection } from "../../app/SelectionProvider";
import { useSettings } from "../../app/SettingsProvider";
import { extensionsFor, labels } from "../../lib/capabilities";
import { dirname, plural } from "../../lib/format";
import type { ConflictPolicy, JobRequest, OperationReport } from "../../lib/types";
import { dialogService } from "../../services/dialogService";
import { FilesCard } from "../workflow/FilesCard";
import { PreviewNotes } from "../workflow/PreviewNotes";
import { WorkflowPage } from "../workflow/WorkflowPage";
import { useReviewPreview } from "../workflow/useReviewPreview";
import { useRunFlow } from "../workflow/useRunFlow";
import { useWorkflowRows } from "../workflow/useWorkflowRows";
import "./pdf.css";

function OfficeForm({ op }: { op: OperationReport }) {
  const { caps } = useCapabilities();
  const { items, add } = useSelection();
  const { settings } = useSettings();
  const { rows, valid } = useWorkflowRows(op.id, items);
  const [outputDir, setOutputDir] = useState<string | null>(settings.defaultOutputDir);
  const engine = caps?.engines.find((e) => e.id === op.engine);
  const installedOnly = engine?.availability.status === "installed";

  const build = useCallback(
    (policy: ConflictPolicy): JobRequest | null =>
      items.length === 0 ? null : { inputs: items.map((i) => i.path), output_dir: outputDir ?? dirname(items[0].path), conflict: policy, operation: { type: "office_to_pdf" } },
    [items, outputDir],
  );
  const request = useMemo(() => (valid ? build("rename") : null), [valid, build]);
  const preview = useReviewPreview(request);
  const flow = useRunFlow({ kind: "office-to-pdf", inputs: items, actionLabel: "Convert", build });
  const blocked = !!preview.error || (preview.review?.errors.length ?? 0) > 0;

  return (
    <>
      <FilesCard
        title="Documents to convert"
        rows={rows}
        hint={`${labels(caps!, op.inputs)}`}
        addLabel="Add documents"
        onBrowse={async () => add(await dialogService.pickFiles([{ name: "Documents", extensions: extensionsFor(caps!, op.inputs) }], "Choose documents"))}
      />
      <Card title="Options">
        <div className="options-grid">
          <OutputFolder value={outputDir} onChange={setOutputDir} />
          <p className="field__hint">Each document becomes a PDF with the same name. Documents are opened in a separate, locked-down process with macros switched off; nothing is sent anywhere.</p>
        </div>
      </Card>
      {installedOnly && (
        <Callout tone="info" title="Using the LibreOffice installed on this computer">
          This copy of OrangeFile didn't include its own, so the one already installed is used.
        </Callout>
      )}
      <Callout tone="info" title="Layout can differ from Microsoft Office">
        The PDF is drawn by LibreOffice. Fonts, spacing and page breaks can differ slightly from how Word, Excel or PowerPoint show the document. Check the result before you send it.
      </Callout>
      <PreviewNotes preview={{ ...preview, review: preview.review && { ...preview.review, warnings: preview.review.warnings.filter((w) => !w.startsWith("The PDF is drawn by LibreOffice")) } }} startError={flow.error} />
      <div className="action-bar action-bar--sticky">
        <span className="action-bar__note">{items.length > 0 ? `${plural(items.length, "document")} → ${plural(items.length, "PDF")}` : "Choose a document."}</span>
        <Button variant="primary" onClick={() => void flow.begin()} disabled={!valid || flow.busy || blocked || preview.loading}>
          {flow.busy ? "Checking…" : "Convert to PDF"}
        </Button>
      </div>
      {flow.dialog}
    </>
  );
}

export function OfficeToPdfPage() {
  return (
    <WorkflowPage kind="office-to-pdf" title="Documents to PDF" subtitle="Turn Word, Excel, PowerPoint and OpenDocument files into PDFs. Your originals are never changed.">
      <CapabilityGate operationId="office_to_pdf">{(op) => <OfficeForm op={op} />}</CapabilityGate>
    </WorkflowPage>
  );
}
