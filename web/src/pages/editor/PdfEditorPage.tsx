import { CheckCircle2, Download, Eraser, FolderOpen, Loader2, RotateCcw, ScanLine, X, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "../../components/ToolShell";
import { DownloadLink } from "../../components/Download";
import { Button, Callout, Dialog, ProgressBar, cx } from "../../components/ui";
import { operationState } from "../../lib/capabilities";
import { messageOf } from "../../lib/errors";
import { plural } from "../../lib/format";
import { useCapabilities } from "../../state/CapabilitiesProvider";
import { useOnDrop, useDragging } from "../../state/DropProvider";
import { useEditor } from "../../state/EditorProvider";
import { useJobs } from "../../state/JobsProvider";
import { AnnotationBar } from "./annotations/AnnotationBar";
import { SignatureDialog } from "./annotations/SignatureDialog";
import type { ToolKey } from "./annotations/useAnnotations";
import { EditorToolbar } from "./EditorToolbar";
import { PasswordPrompt } from "./PasswordPrompt";
import { PdfPreview } from "./PdfPreview";
import { PdfThumbnails } from "./PdfThumbnails";
import { turned } from "./plan";
import { SaveDialog, type SaveMode } from "./SaveDialog";
import { ToolsPanel, type ToolAction } from "./ToolsPanel";
import { displayWidth, percentOf } from "./zoom";

const FIRST = "Open a PDF first.";

/** Progress and outcome of the last "Save a copy". It stays until dismissed. */
function SaveStatus() {
  const { jobs, currentByTool, dismissCurrent, cancel } = useJobs();
  const job = jobs.find((j) => j.id === currentByTool["pdf-pages"]);
  if (!job) return null;
  const active = job.phase === "uploading" || job.phase === "processing";
  const file = job.manifest?.files[0];
  const tone = active ? "border-brand-200 bg-brand-50 dark:border-brand-900 dark:bg-brand-900/20" : job.phase === "completed" ? "border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40" : "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40";
  return (
    <div role="status" aria-live="polite" className={cx("mb-4 flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 text-sm", tone)}>
      {active ? <Loader2 className="size-5 animate-spin text-brand-700" aria-hidden /> : job.phase === "completed" ? <CheckCircle2 className="size-5 text-emerald-700" aria-hidden /> : <XCircle className="size-5 text-red-700" aria-hidden />}
      <div className="min-w-0 flex-1">
        {active && (
          <>
            <strong className="font-semibold">{job.phase === "uploading" ? "Sending" : "Saving"} “{job.title}”…</strong> {job.percent}%
            <div className="mt-1.5 max-w-xs">
              <ProgressBar percent={job.percent} label="Saving progress" />
            </div>
          </>
        )}
        {job.phase === "completed" && (
          <>
            <strong className="font-semibold">Saved “{job.title}”</strong>
            {job.detail ? ` · ${job.detail}` : ""}
          </>
        )}
        {job.phase === "failed" && (
          <>
            <strong className="font-semibold">The copy wasn't saved.</strong> {job.error?.message ?? job.results.find((r) => r.outcome === "failed")?.message ?? "Something went wrong."} Your original was not changed.
          </>
        )}
        {job.phase === "cancelled" && <strong className="font-semibold">Saving was cancelled. Your original was not changed.</strong>}
        {job.phase === "expired" && <strong className="font-semibold">That copy has been deleted from the server.</strong>}
      </div>
      {active && (
        <Button size="sm" variant="danger" onClick={() => cancel(job.id)}>
          Cancel
        </Button>
      )}
      {job.phase === "completed" && job.serverId && file && (
        <DownloadLink primary job={job.serverId} index={file.index} className="h-9">
          <Download className="size-4" aria-hidden /> Download
        </DownloadLink>
      )}
      {!active && (
        <Button size="sm" variant="ghost" onClick={() => dismissCurrent("pdf-pages")}>
          Dismiss
        </Button>
      )}
    </div>
  );
}

/**
 * The PDF editor: page thumbnails, a large preview with annotations, and a tools panel. Page changes (reorder, rotate, delete)
 * and annotations are kept in the browser as a plan and only become a file when the user saves a copy, so the original is never
 * touched. Everything is driven by the capability report.
 */
export default function PdfEditorPage() {
  const { caps } = useCapabilities();
  const pdf = useEditor();
  const { state, images, page, plan, dirty, planDirty, annotationCount, annotations: A, zoom, open, unlock, close, resetPlan, discard, resolveDiscard, selected } = pdf;
  const [saving, setSaving] = useState<SaveMode | null>(null);
  const [signing, setSigning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const pictureInput = useRef<HTMLInputElement>(null);
  const dragging = useDragging();

  const ready = state.status === "ready" ? state : null;
  const can = (op: string) => (caps ? operationState(caps, op).state === "ready" : false);
  const canView = can("pdf_view");
  const canAnnotate = can("pdf_annotate");
  const canSave = can("pdf_reorder") || can("pdf_rotate") || can("pdf_delete_pages") || canAnnotate;
  const viewReason = caps ? (() => { const s = operationState(caps, "pdf_view"); return s.state === "ready" ? "" : s.reason; })() : "";

  const openFile = (f: File) => {
    setNotice(null);
    void open(f);
  };
  // A dropped PDF opens in the editor (only one at a time).
  useOnDrop(
    canView
      ? (items) => {
          const pdfs = items.filter((i) => i.name.toLowerCase().endsWith(".pdf"));
          if (pdfs.length === 0) return setNotice("Only PDF files can be opened here.");
          if (items.length > 1) setNotice("Only one PDF can be open at a time, so the first PDF was opened.");
          openFile(pdfs[0].file);
        }
      : null,
  );

  const entry = ready ? plan[page - 1] : undefined;
  const turnedInfo = ready && entry ? turned(ready.doc.info.pages[entry.src - 1], entry.rot) : undefined;
  const percent = turnedInfo ? percentOf(displayWidth(zoom, turnedInfo, { w: 900, h: 700 }), turnedInfo) : 100;

  const addPicture = async (file: File) => {
    try {
      const picture = await A.addPicture(file);
      A.setTool("image");
      A.setPending({ kind: "picture", picture });
    } catch (e) {
      setNotice(messageOf(e));
    }
  };

  const actions = useMemo<Record<string, ToolAction>>(() => {
    const keys = ["rotate-left", "rotate-right", "move-earlier", "move-later", "delete", "extract", "highlight", "underline", "strikethrough", "comment", "draw", "shapes", "text-box", "image", "visual-signature"];
    if (!ready) return Object.fromEntries(keys.map((k) => [k, { run: () => undefined, unavailable: FIRST }]));
    const count = selected.length || 1;
    const pick = (t: ToolKey): ToolAction => ({ run: () => A.setTool(A.tool === t ? null : t), active: A.tool === t });
    return {
      "rotate-left": { run: () => pdf.rotateSelected(-90) },
      "rotate-right": { run: () => pdf.rotateSelected(90) },
      "move-earlier": { run: () => pdf.moveSelected(-1) },
      "move-later": { run: () => pdf.moveSelected(1) },
      delete: { run: pdf.deleteSelected, unavailable: count >= plan.length ? "A PDF needs at least one page." : undefined },
      extract: { run: () => setSaving("extract") },
      highlight: pick("highlight"),
      underline: pick("underline"),
      strikethrough: pick("strikethrough"),
      comment: pick("comment"),
      draw: pick("draw"),
      shapes: pick("shapes"),
      "text-box": pick("text-box"),
      image: { run: () => (A.tool === "image" ? A.setTool(null) : pictureInput.current?.click()), active: A.tool === "image" },
      "visual-signature": { run: () => setSigning(true), active: A.tool === "visual-signature" },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, selected, plan.length, A.tool, pdf.rotateSelected, pdf.moveSelected, pdf.deleteSelected]);

  // Undo and redo from the keyboard anywhere on the page, unless the user is typing in a field or a dialog is open.
  const { undo, redo } = A;
  useEffect(() => {
    if (!canAnnotate) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (!(e.ctrlKey || e.metaKey) || t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || document.querySelector('[role="dialog"]')) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) undo();
      else if (k === "y" || (k === "z" && e.shiftKey)) redo();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canAnnotate, undo, redo]);

  return (
    <>
      <PageHeader
        title="PDF editor"
        subtitle={ready ? ready.doc.name : "View pages, reorder, rotate, delete and extract them, and annotate. Your original is never changed."}
        actions={
          <>
            <Button icon={<FolderOpen className="size-4" aria-hidden />} disabled={!canView} title={canView ? undefined : viewReason} onClick={() => picker.current?.click()}>
              Open PDF
            </Button>
            {ready && (
              <Button icon={<X className="size-4" aria-hidden />} onClick={close}>
                Close PDF
              </Button>
            )}
            <Button variant="primary" disabled={!ready || !dirty || !canSave} title={!ready ? FIRST : !dirty ? "Change the pages or add an annotation first." : "Save the changes as a new PDF"} onClick={() => setSaving("copy")}>
              Save copy
            </Button>
          </>
        }
      />
      <input
        ref={picker}
        type="file"
        accept=".pdf,application/pdf"
        className="sr-only"
        tabIndex={-1}
        aria-label="Choose a PDF to open"
        onChange={(e) => {
          if (e.target.files?.[0]) openFile(e.target.files[0]);
          e.target.value = "";
        }}
      />
      <input
        ref={pictureInput}
        type="file"
        accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
        className="sr-only"
        tabIndex={-1}
        aria-label="Choose a picture to place on the page"
        onChange={(e) => {
          if (e.target.files?.[0]) void addPicture(e.target.files[0]);
          e.target.value = "";
        }}
      />
      <SaveStatus />
      <div className="mb-4 flex flex-col gap-3 empty:hidden">
        {!canView && caps && (
          <Callout tone="warning" title="The PDF editor isn't available on this server">
            {viewReason} Nothing here can run until the PDF engine is available.
          </Callout>
        )}
        {state.status === "error" && (
          <Callout tone="error" title={`“${state.name}” couldn't be opened`}>
            {state.message}
          </Callout>
        )}
        {notice && <Callout tone="info">{notice}</Callout>}
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
          <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-950 dark:border-brand-900 dark:bg-brand-900/20 dark:text-brand-100">
            <span className="min-w-0 flex-1">
              <strong className="font-semibold">Changes not saved.</strong> The new PDF will have {plural(plan.length, "page")}
              {plan.length !== ready.doc.info.page_count ? ` (the original has ${ready.doc.info.page_count})` : ""}
              {annotationCount > 0 ? ` and ${plural(annotationCount, "annotation")}` : ""}. Nothing is saved until you press Save copy.
            </span>
            {planDirty && (
              <Button size="sm" icon={<RotateCcw className="size-4" aria-hidden />} onClick={resetPlan}>
                Reset pages
              </Button>
            )}
            {annotationCount > 0 && (
              <Button size="sm" icon={<Eraser className="size-4" aria-hidden />} onClick={A.clear}>
                Remove annotations
              </Button>
            )}
          </div>
        )}
      </div>

      <div aria-label="PDF editor workspace" className="grid min-h-[34rem] gap-4 lg:h-[calc(100vh-15rem)] lg:grid-cols-[9.5rem_minmax(0,1fr)_17rem] lg:grid-rows-1 [&>*]:min-h-0">
        {ready && images ? (
          <div className="max-h-56 min-h-0 lg:max-h-none [&>aside]:h-full">
            <PdfThumbnails key={ready.doc.id} doc={ready.doc} images={images} />
          </div>
        ) : (
          <aside aria-label="Page thumbnails" className="flex flex-col gap-2 rounded-2xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="px-1 text-sm font-semibold text-slate-900 dark:text-slate-100">Pages</h2>
            <p className="rounded-xl border-2 border-dashed border-slate-200 p-3 text-center text-xs text-slate-600 dark:border-slate-700 dark:text-slate-400">Pages appear here once a PDF is open.</p>
          </aside>
        )}
        <section aria-label="Page view" className={cx("flex min-h-[28rem] flex-col overflow-hidden rounded-2xl border bg-white dark:bg-slate-900", dragging && canView ? "border-brand-600 ring-2 ring-brand-600" : "border-slate-200 dark:border-slate-800")}>
          <EditorToolbar enabled={!!ready} pageCount={ready ? plan.length : 0} percent={percent} />
          {canAnnotate && <AnnotationBar enabled={!!ready} />}
          <div className="relative min-h-0 flex-1 bg-slate-100 dark:bg-slate-950">
            {ready && images && entry ? (
              <PdfPreview key={ready.doc.id} doc={ready.doc} images={images} />
            ) : state.status === "opening" ? (
              <div role="status" className="grid size-full place-items-center p-6 text-center">
                <div className="flex w-64 flex-col items-center gap-3">
                  <Loader2 className="size-8 animate-spin text-brand-600" aria-hidden />
                  <h2 className="font-semibold text-slate-900 dark:text-slate-100">Opening {state.name}…</h2>
                  <ProgressBar percent={state.percent} label="Sending the PDF" />
                </div>
              </div>
            ) : state.status === "password" ? (
              <PasswordPrompt name={state.file.name} wrong={state.wrong} onSubmit={(p) => void unlock(p)} onCancel={close} />
            ) : (
              <div className="grid size-full place-items-center p-6">
                <div className="flex max-w-sm flex-col items-center gap-2 text-center text-slate-600 dark:text-slate-400">
                  <ScanLine className="size-8 text-slate-400" aria-hidden />
                  <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">No PDF open</h2>
                  <p className="text-sm">{canView ? (dragging ? "Release to open this PDF." : "Choose Open PDF, or drop a PDF anywhere on this page.") : "Open a PDF to see its pages."}</p>
                  {canView && (
                    <Button variant="primary" icon={<FolderOpen className="size-4" aria-hidden />} onClick={() => picker.current?.click()}>
                      Open PDF
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>
        <ToolsPanel doc={ready?.doc ?? null} actions={actions} />
      </div>

      {saving && <SaveDialog mode={saving} onClose={() => setSaving(null)} />}
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
      {discard && (
        <Dialog
          title="Discard your changes?"
          description={discard.kind === "open" ? "Opening another PDF will throw away the changes and annotations you made to this one." : "Closing this PDF will throw away the changes and annotations you made to it."}
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
          <p className="text-sm text-slate-600 dark:text-slate-400">Nothing has been saved. Use Save copy first if you want to keep them.</p>
        </Dialog>
      )}
    </>
  );
}
