import { PageHeader } from "../components/ToolShell";
import { ToolCards } from "../components/ToolCards";
import { Callout } from "../components/ui";
import { useCapabilities } from "../state/CapabilitiesProvider";

export function PdfHub() {
  const { state } = useCapabilities();
  const anyPdf = state.status === "ready" && state.caps.operations.some((o) => o.id.startsWith("pdf_") && o.available);
  return (
    <>
      <PageHeader title="PDF tools" subtitle="Merge, split, annotate and convert PDFs, pictures and Office documents." />
      {state.status === "ready" && !anyPdf && (
        <div className="mb-5">
          <Callout tone="warning" title="The PDF engine isn't available on this server">
            Nothing here can run until it is, and nothing here pretends to.
          </Callout>
        </div>
      )}
      <ToolCards group="pdf" />
    </>
  );
}
