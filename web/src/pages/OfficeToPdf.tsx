import { useMemo } from "react";
import { ActionBar, PreviewNotes, ToolShell, useDropIntoSelection, useToolRows } from "../components/ToolShell";
import { FilesCard } from "../components/FilesCard";
import { Button, Callout } from "../components/ui";
import { extensionsFor, labels } from "../lib/capabilities";
import { plural } from "../lib/format";
import { titleFor, toUploads } from "../lib/run";
import { usePreview } from "../lib/usePreview";
import type { OperationReport } from "../lib/types";
import { useCapabilities } from "../state/CapabilitiesProvider";
import { useJobs } from "../state/JobsProvider";
import { useSelection } from "../state/SelectionProvider";
import { t } from "../lib/i18n";

export function OfficeToPdfPage() {
  return (
    <ToolShell tool="office-to-pdf" opId="office_to_pdf" title={t("Documents to PDF")} subtitle={t("Turn Word, Excel, PowerPoint and OpenDocument files into PDFs. Your originals are never changed.")}>
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
  const options = useMemo(() => ({}), []);
  const preview = usePreview(valid ? "office_to_pdf" : null, options, items);
  const engine = caps?.engines.find((e) => e.id === op.engine);

  return (
    <>
      <FilesCard title={t("Documents to convert")} rows={rows} accept={extensionsFor(caps!, op.inputs)} hint={`${labels(caps!, op.inputs)}`} noun="document" addLabel={t("Add documents")} />
      {engine?.availability.status === "installed" && (
        <Callout tone="info" title={t("Using the LibreOffice installed on the server")}>
          {t("This server doesn't include its own copy, so the one that is installed there is used.")}
        </Callout>
      )}
      <Callout tone="info" title={t("Layout can differ from Microsoft Office")}>
        {t("The PDF is drawn by LibreOffice. Fonts, spacing and page breaks can differ slightly from how Word, Excel or PowerPoint show the document. Macros are never run. Check the result before you send it.")}
      </Callout>
      <PreviewNotes preview={preview} />
      <ActionBar note={items.length ? `${plural(items.length, "document")} → ${plural(items.length, "PDF")}` : t("Choose a document.")}>
        <Button variant="primary" disabled={!valid || !preview.ok || preview.loading} onClick={() => start({ tool: "office-to-pdf", operation: "office_to_pdf", options, files: toUploads(items), title: titleFor(items), detail: null })}>
          {t("Convert to PDF")}
        </Button>
      </ActionBar>
    </>
  );
}
