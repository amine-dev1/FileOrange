import { FilePenLine } from "lucide-react";
import { Callout } from "../../components/Callout";
import { OperationCard } from "../../components/OperationCard";
import { PageHeader } from "../../components/PageHeader";
import { useCapabilities } from "../../app/CapabilitiesProvider";
import { useNav } from "../../app/NavProvider";
import { PDF_TASKS, PDF_TASK_ROUTE, pdfTaskState } from "./tasks";
import "./pdf.css";

export function PdfToolsPage() {
  const { caps, state } = useCapabilities();
  const { go } = useNav();
  const anyPdf = !!caps && caps.operations.some((o) => o.id.startsWith("pdf_") && o.available);
  const editor = pdfTaskState(caps, "pdf_view");
  const hasPdfOps = !!caps && caps.operations.some((o) => o.id.startsWith("pdf_"));

  return (
    <>
      <PageHeader title="PDF Tools" subtitle="Merge, split, annotate and convert PDF files on this computer." />
      {state.status === "error" && <Callout tone="error" title="Couldn't load what is available">{state.message}</Callout>}
      {state.status === "ready" && !anyPdf && (
        <Callout tone="info" title={hasPdfOps ? "The PDF engine is not available right now" : "PDF tools are not available yet"}>
          {hasPdfOps
            ? `${editor.reason ?? ""} Nothing on this page can run until it is, and nothing here pretends to.`
            : "They need a PDF engine, which is not part of this version of OrangeFile. Nothing on this page can run yet, and nothing here pretends to."}{" "}
          Each tool switches on by itself when its engine is reported as available.
        </Callout>
      )}
      {state.status === "ready" && anyPdf && (
        <Callout tone="info" title="You can open and preview PDFs">
          Merge, split, reorder, rotate, delete and extract pages, annotate, and convert between PDFs, pictures and Office documents work now. Forms and the other tools below are planned for later updates and stay switched off until they exist.
        </Callout>
      )}
      <div className="pdf-grid">
        <OperationCard
          Icon={FilePenLine}
          title="Open PDF Editor"
          description="Preview pages, reorder, rotate, delete and extract them, and annotate."
          tag={editor.enabled ? undefined : (editor.label ?? undefined)}
          disabled={false}
          onClick={() => go("pdf-editor")}
        />
        {PDF_TASKS.map((t) => {
          const st = pdfTaskState(caps, t.opId);
          return <OperationCard key={t.opId} Icon={t.Icon} title={t.title} description={st.enabled ? t.description : (st.reason ?? t.description)} tag={st.label ?? undefined} disabled={!st.enabled} reason={st.reason ?? undefined} onClick={() => go(PDF_TASK_ROUTE[t.opId] ?? "pdf-editor")} />;
        })}
      </div>
    </>
  );
}
