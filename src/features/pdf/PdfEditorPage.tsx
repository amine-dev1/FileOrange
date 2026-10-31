import { Download, Eraser, FolderOpen, Loader2, RotateCcw, ScanLine, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { Dialog } from "../../components/Dialog";
import { PageHeader } from "../../components/PageHeader";
import { useCapabilities } from "../../app/CapabilitiesProvider";
import { useDragging } from "../../app/DropProvider";
import { useNav } from "../../app/NavProvider";
import { usePdf } from "../../app/PdfProvider";
import { useSelection } from "../../app/SelectionProvider";
import { useToast } from "../../app/ToastProvider";
import { extensionsFor } from "../../lib/capabilities";
import { plural } from "../../lib/format";
import { messageOf } from "../../lib/tauri";
import { dialogService } from "../../services/dialogService";
import { AnnotationBar } from "./annotations/AnnotationBar";
import { SignatureDialog } from "./annotations/SignatureDialog";
import type { ToolKey } from "./annotations/useAnnotations";
import { EditorToolbar } from "./EditorToolbar";
import { PdfPasswordPrompt } from "./PdfPasswordPrompt";
import { PdfPreview } from "./PdfPreview";
import { PdfSaveDialog, type SaveMode } from "./PdfSaveDialog";
import { PdfSaveStatus } from "./PdfSaveStatus";
import { PdfThumbnailStrip } from "./PdfThumbnailStrip";
import { PdfToolsPanel, type ToolAction } from "./PdfToolsPanel";
import { turned } from "./plan";
import { pdfTaskState } from "./tasks";
import { displayWidth, percentOf } from "./zoom";
import "./pdf.css";

const NOT_YET = "Saving the other kinds of changes isn't available yet.";
const FIRST = "Open a PDF first.";

/**
 * The PDF editor workspace: page thumbnails, a large preview, and a tools panel. Everything is driven by the
 * capability report. Page changes (reorder, rotate, delete) are kept as a plan and only become a file when the
 * user saves a copy, so the original is never touched. With no PDF engine the workspace is switched off with the
 * engine's own reason, and no control pretends to work.
 */
export function PdfEditorPage() {
  const { caps } = useCapabilities();
  const { push } = useToast();
  const { go } = useNav();
  const selection = useSelection();
  const dragging = useDragging();
  const pdf = usePdf();
  const { state, images, page, plan, dirty, planDirty, annotationCount, annotations: A, selected, zoom, open, unlock, close, resetPlan, discard, resolveDiscard } = pdf;
  const [saving, setSaving] = useState<SaveMode | null>(null);
  const [signing, setSigning] = useState(false);
  const view = pdfTaskState(caps, "pdf_view");
  const canOpen = view.enabled;
  const reason = view.reason ?? "";
  const ready = state.status === "ready" ? state : null;
  const canAnnotate = pdfTaskState(caps, "pdf_annotate").enabled;
  const canSave = pdfTaskState(caps, "pdf_reorder").enabled || pdfTaskState(caps, "pdf_rotate").enabled || pdfTaskState(caps, "pdf_delete_pages").enabled || canAnnotate;

  const choose = async () => {
    try {
      const path = await dialogService.pickFile(caps ? [{ name: "PDF files", extensions: extensionsFor(caps, ["pdf"]) }] : undefined, "Open PDF");
      if (path) await open(path);
    } catch (e) {
      push("error", messageOf(e));
    }
  };

  // The toolbar shows the zoom that is actually applied, whichever mode produced it.
  const entry = ready ? plan[page - 1] : undefined;
  const turnedInfo = ready && entry ? turned(ready.doc.info.pages[entry.src - 1], entry.rot) : undefined;
  const percent = turnedInfo ? percentOf(displayWidth(zoom, turnedInfo, { w: 900, h: 700 }), turnedInfo) : 100;

  const pickPicture = async () => {
    try {
      const path = await dialogService.pickFile([{ name: "Pictures", extensions: caps ? extensionsFor(caps, ["jpeg", "png", "webp"]) : ["jpg", "jpeg", "png", "webp"] }], "Choose a picture to place on the page");
      if (!path) return;
      const picture = await A.addPicture(path);
      A.setTool("image");
      A.setPending({ kind: "picture", picture });
    } catch (e) {
      push("error", messageOf(e));
    }
  };

  const actions = useMemo<Record<string, ToolAction>>(() => {
    const annotateKeys = ["highlight", "underline", "strikethrough", "comment", "draw", "shapes", "text-box", "image", "visual-signature"];
    if (!ready) return Object.fromEntries(["rotate-left", "rotate-right", "move-earlier", "move-later", "delete", "extract", "split", "merge", ...annotateKeys].map((k) => [k, { run: () => undefined, unavailable: FIRST }]));
    const pick = (t: ToolKey): ToolAction => ({ run: () => A.setTool(A.tool === t ? null : t), active: A.tool === t });
    const count = selected.length || 1;
    const edits = dirty ? "Save a copy first: this uses the file as it is on disk, not your unsaved page changes." : undefined;
    const sendFileTo = async (replace: boolean, to: "pdf-split" | "pdf-merge") => {
      if (replace) selection.clear();
      await selection.add([ready.path]);
      go(to);
    };
    return {
      "rotate-left": { run: () => pdf.rotateSelected(-90) },
      "rotate-right": { run: () => pdf.rotateSelected(90) },
      "move-earlier": { run: () => pdf.moveSelected(-1) },
      "move-later": { run: () => pdf.moveSelected(1) },
      delete: { run: pdf.deleteSelected, unavailable: count >= plan.length ? "A PDF needs at least one page." : undefined },
      extract: { run: () => setSaving("extract") },
      split: { run: () => void sendFileTo(true, "pdf-split"), unavailable: edits },
      merge: { run: () => void sendFileTo(false, "pdf-merge"), unavailable: edits },
      highlight: pick("highlight"),
      underline: pick("underline"),
      strikethrough: pick("strikethrough"),
      comment: pick("comment"),
      draw: pick("draw"),
      shapes: pick("shapes"),
      "text-box": pick("text-box"),
      image: { run: () => (A.tool === "image" ? A.setTool(null) : void pickPicture()), active: A.tool === "image" },
      "visual-signature": { run: () => setSigning(true), active: A.tool === "visual-signature" },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, selected, plan.length, dirty, A.tool, pdf.rotateSelected, pdf.moveSelected, pdf.deleteSelected, selection.add, selection.clear, go, caps]);

  // Undo and redo from the keyboard, unless the user is typing in a field.
  const onEditorKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || !(e.ctrlKey || e.metaKey) || !canAnnotate) return;
    const k = e.key.toLowerCase();
    if (k === "z" && !e.shiftKey) A.undo();
    else if (k === "y" || (k === "z" && e.shiftKey)) A.redo();
    else return;
    e.preventDefault();
  };

  return (
    <>
      <PageHeader
        title="PDF Editor"
        subtitle={ready ? ready.doc.name : "Preview pages, reorder, rotate, delete and extract them, and annotate. Forms come in a later update."}
        actions={
          <>
            <Button icon={<FolderOpen size={16} aria-hidden />} disabled={!canOpen} title={canOpen ? undefined : reason} onClick={() => void choose()}>
              Open PDF
            </Button>
            {ready && (
              <Button variant="secondary" icon={<X size={16} aria-hidden />} onClick={close}>
                Close PDF
              </Button>
            )}
            <Button variant="secondary" icon={<Download size={16} aria-hidden />} disabled title={NOT_YET}>
              Export
            </Button>
            <Button variant="primary" disabled={!ready || !dirty || !canSave} title={!ready ? FIRST : !canSave ? "Saving changes isn't available." : !dirty ? "Change the pages or add an annotation first." : "Save the changes as a new PDF"} onClick={() => setSaving("copy")}>
              Save Copy
            </Button>
          </>
        }
      />
      <PdfSaveStatus />
      {!canOpen && caps && (
        <Callout tone="info" title={view.label === "Coming later" ? "The PDF editor is not available yet" : "The PDF editor is not available right now"}>
          {reason} Everything below is switched off until a PDF engine is reported as available. Nothing will be simulated.
        </Callout>
      )}
      {state.status === "error" && (
        <Callout tone="error" title={`“${state.name}” couldn't be opened`}>
          {state.message}
        </Callout>
      )}
      {ready && ready.doc.info.warnings.length > 0 && (
        <Callout tone="warning" title="Before you change this PDF">
          <ul>
            {ready.doc.info.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Callout>
      )}
      {ready?.doc.info.has_form && (
        <Callout tone="info" title="This PDF has form fields">
          They are shown as they were saved. Filling them in is not available yet.
        </Callout>
      )}
      {dirty && ready && (
        <div className="dirty-bar" role="status">
          <span>
            <strong>Changes not saved.</strong> The new PDF will have {plural(plan.length, "page")}
            {plan.length !== ready.doc.info.page_count ? ` (the original has ${ready.doc.info.page_count})` : ""}
            {annotationCount > 0 ? ` and ${plural(annotationCount, "annotation")}` : ""}. Nothing is written until you press Save Copy.
          </span>
          {planDirty && (
            <Button size="sm" icon={<RotateCcw size={15} aria-hidden />} onClick={resetPlan}>
              Reset pages
            </Button>
          )}
          {annotationCount > 0 && (
            <Button size="sm" icon={<Eraser size={15} aria-hidden />} onClick={A.clear}>
              Remove annotations
            </Button>
          )}
        </div>
      )}

      <div className="editor" aria-label="PDF editor workspace" onKeyDown={onEditorKey}>
        {ready && images ? (
          <PdfThumbnailStrip key={ready.doc.id} doc={ready.doc} images={images} />
        ) : (
          <aside className="editor__thumbs" aria-label="Page thumbnails">
            <h2 className="editor__panel-title">Pages</h2>
            <div className="editor__thumbs-empty">
              <p>Pages appear here once a PDF is open.</p>
            </div>
          </aside>
        )}
        <section className={`editor__center ${dragging && canOpen ? "editor__center--drop" : ""}`} aria-label="Page view">
          <EditorToolbar enabled={!!ready} reason={canOpen ? FIRST : reason} pageCount={ready ? plan.length : 0} percent={percent} />
          {canAnnotate && <AnnotationBar enabled={!!ready} />}
          <div className="editor__canvas">
            {ready && images && entry ? (
              <PdfPreview key={ready.doc.id} doc={ready.doc} images={images} />
            ) : state.status === "opening" ? (
              <div className="editor__empty" role="status">
                <Loader2 size={30} className="spin" aria-hidden />
                <h2>Opening {state.name}…</h2>
              </div>
            ) : state.status === "password" ? (
              <PdfPasswordPrompt name={state.name} wrong={state.wrong} onSubmit={(p) => void unlock(p)} onCancel={close} />
            ) : (
              <div className="editor__empty">
                <ScanLine size={30} aria-hidden />
                <h2>No PDF open</h2>
                <p>{canOpen ? (dragging ? "Release to open this PDF." : "Choose Open PDF, or drop a PDF onto this window.") : "Open a PDF to preview its pages."}</p>
                {canOpen && (
                  <Button variant="primary" icon={<FolderOpen size={16} aria-hidden />} onClick={() => void choose()}>
                    Open PDF
                  </Button>
                )}
              </div>
            )}
          </div>
        </section>
        <PdfToolsPanel doc={ready?.doc ?? null} actions={actions} />
      </div>

      {saving && <PdfSaveDialog mode={saving} onClose={() => setSaving(null)} />}
      {signing && (
        <SignatureDialog
          onClose={() => setSigning(false)}
          onUse={(signature) => {
            setSigning(false);
            A.setTool("visual-signature");
            A.setPending({ kind: "signature", signature });
          }}
        />
      )}
      <Dialog
        open={!!discard}
        title="Discard your changes?"
        description={discard?.kind === "open" ? "Opening another PDF will throw away the changes and annotations you made to this one." : "Closing this PDF will throw away the changes and annotations you made to it."}
        onClose={() => resolveDiscard(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => resolveDiscard(false)}>
              Keep editing
            </Button>
            <Button variant="danger" onClick={() => resolveDiscard(true)}>
              Discard changes
            </Button>
          </>
        }
      >
        <p>Nothing has been saved. Use Save Copy first if you want to keep them.</p>
      </Dialog>
    </>
  );
}
