import { useMemo, useState } from "react";
import { Button, Callout, Dialog, Field, TextInput } from "../../components/ui";
import { plural } from "../../lib/format";
import { withExtension } from "../../lib/run";
import { usePreview } from "../../lib/usePreview";
import { toItem } from "../../lib/files";
import { PreviewNotes } from "../../components/ToolShell";
import { useEditor } from "../../state/EditorProvider";
import { useJobs } from "../../state/JobsProvider";
import { measureText } from "./annotations/measure";
import { drawable, toWire, usedPictures } from "./annotations/model";
import { toJobPages } from "./plan";

export type SaveMode = "copy" | "extract";

/**
 * Save the page plan (and any annotations) as a new PDF, or just the selected pages of it. The original is never touched:
 * this starts an ordinary job on the server with the same progress, cancel and download as every other one.
 */
export function SaveDialog({ mode, onClose }: { mode: SaveMode; onClose: () => void }) {
  const { state, plan, selected, passwordForSave, annotations: A } = useEditor();
  const { start } = useJobs();
  const doc = state.status === "ready" ? state : null;
  const stem = (doc?.doc.name ?? "document").replace(/\.[^.]+$/, "");
  const [name, setName] = useState(`${stem} (${mode === "copy" ? "edited" : "extract"})`);

  const chosen = useMemo(() => (mode === "copy" ? plan : plan.filter((p) => selected.includes(p.id))), [mode, plan, selected]);
  // Annotations on the pages being saved, and the picture files they use (sent after the PDF).
  const keep = useMemo(() => new Set(chosen.map((p) => p.src)), [chosen]);
  const pictureIds = useMemo(() => usedPictures(mode === "copy" ? A.list : [], keep), [mode, A.list, keep]);
  const pictures = useMemo(() => pictureIds.map((id) => A.pictures.find((p) => p.id === id)).filter((p): p is NonNullable<typeof p> => !!p), [pictureIds, A.pictures]);
  const wire = useMemo(() => toWire(mode === "copy" ? A.list : [], keep, new Map(pictureIds.map((id, i) => [id, i])), measureText), [mode, A.list, keep, pictureIds]);
  const cannotDraw = useMemo(() => (mode === "copy" ? A.list.filter((a) => keep.has(a.page) && a.kind === "text" && !drawable(a.text)).length : 0), [mode, A.list, keep]);

  const options = useMemo(
    () => ({ pages: toJobPages(chosen), output_name: name.trim() || null, password: passwordForSave(), ...(wire.length > 0 ? { annotations: wire } : {}) }),
    [chosen, name, passwordForSave, wire],
  );
  // The preview only needs the shape of the request: the same PDF as the first file, then the pictures.
  const previewItems = useMemo(() => (doc ? [toItem(doc.file, ""), ...pictures.map((p) => toItem(p.file, ""))] : []), [doc, pictures]);
  const preview = usePreview(chosen.length > 0 ? "pdf_pages" : null, options, previewItems);
  const blocked = !preview.ok || preview.loading || cannotDraw > 0 || chosen.length === 0 || name.trim().length === 0;

  const run = () => {
    if (!doc) return;
    start({
      tool: "pdf-pages",
      operation: "pdf_pages",
      options,
      files: [{ file: doc.file, name: doc.doc.name }, ...pictures.map((p) => ({ file: p.file, name: p.name }))],
      title: withExtension(name, "pdf", `${stem} (edited)`),
      detail: wire.length > 0 ? `${plural(chosen.length, "page")}, ${plural(wire.length, "annotation")}` : plural(chosen.length, "page"),
    });
    onClose();
  };

  return (
    <Dialog
      title={mode === "copy" ? "Save a copy" : "Extract pages"}
      description={mode === "copy" ? `A new PDF with ${plural(chosen.length, "page")}, in the order shown. Your original is not changed.` : `A new PDF with the ${plural(chosen.length, "selected page")}. Your original is not changed.`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={run} disabled={blocked}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="File name" htmlFor="save-name" hint="“.pdf” is added for you.">
          <TextInput id="save-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} spellCheck={false} />
        </Field>
        {wire.length > 0 && <Callout tone="info">{plural(wire.length, "annotation")} will be drawn into the new PDF. They become part of the page and can't be edited afterwards, so keep this editor open if you may want to change them.</Callout>}
        {cannotDraw > 0 && (
          <Callout tone="error" title="Some text can't be saved">
            {plural(cannotDraw, "text annotation")} use{cannotDraw === 1 ? "s" : ""} characters the built-in PDF font can't draw (it covers Latin letters with accents and common punctuation, not Arabic, Chinese, emoji and so on). Edit or remove {cannotDraw === 1 ? "it" : "them"} to save.
          </Callout>
        )}
        <PreviewNotes preview={preview} />
      </div>
    </Dialog>
  );
}
