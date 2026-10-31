import { useCallback, useMemo, useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Field, TextInput } from "../../components/Fields";
import { OutputFolder } from "../../components/OutputFolder";
import { usePdf } from "../../app/PdfProvider";
import { useSettings } from "../../app/SettingsProvider";
import { dirname, plural } from "../../lib/format";
import type { ConflictPolicy, JobRequest, PathInfo } from "../../lib/types";
import { PreviewNotes } from "../workflow/PreviewNotes";
import { useReviewPreview } from "../workflow/useReviewPreview";
import { useRunFlow } from "../workflow/useRunFlow";
import { toJobPages } from "./plan";
import { measureText } from "./annotations/measure";
import { drawable, toWire, usedPictures } from "./annotations/model";
import { Callout } from "../../components/Callout";

export type SaveMode = "copy" | "extract";

/**
 * Save the page plan as a new PDF (or just the selected pages of it). The original file is never touched:
 * this starts an ordinary job, with the same dry-run, conflict choices and progress as every other one.
 */
export function PdfSaveDialog({ mode, onClose }: { mode: SaveMode; onClose: () => void }) {
  const { state, plan, selected, passwordForSave, annotations: A } = usePdf();
  const { settings } = useSettings();
  const doc = state.status === "ready" ? state : null;
  const stem = (doc?.doc.name ?? "document").replace(/\.[^.]+$/, "");
  const [name, setName] = useState(`${stem} (${mode === "copy" ? "edited" : "extract"})`);
  const [outputDir, setOutputDir] = useState<string | null>(settings.defaultOutputDir);

  const chosen = useMemo(() => (mode === "copy" ? plan : plan.filter((p) => selected.includes(p.id))), [mode, plan, selected]);
  // Annotations on the pages being saved, and the picture files they use (sent after the PDF).
  const keep = useMemo(() => new Set(chosen.map((p) => p.src)), [chosen]);
  const pictureIds = useMemo(() => usedPictures(A.list, keep), [A.list, keep]);
  const picturePaths = useMemo(() => pictureIds.map((id) => A.pictures.find((p) => p.id === id)?.path).filter((p): p is string => !!p), [pictureIds, A.pictures]);
  const wire = useMemo(() => toWire(A.list, keep, new Map(pictureIds.map((id, i) => [id, i])), measureText), [A.list, keep, pictureIds]);
  const cannotDraw = useMemo(() => A.list.filter((a) => keep.has(a.page) && a.kind === "text" && !drawable(a.text)).length, [A.list, keep]);
  const input: PathInfo[] = useMemo(() => (doc ? [{ path: doc.path, name: doc.doc.name, is_dir: false, size: doc.doc.size, file_count: 1 }] : []), [doc]);

  const build = useCallback(
    (policy: ConflictPolicy): JobRequest | null =>
      !doc || chosen.length === 0
        ? null
        : {
            inputs: [doc.path, ...picturePaths],
            output_dir: outputDir ?? dirname(doc.path),
            conflict: policy,
            operation: { type: "pdf_pages", pages: toJobPages(chosen), output_name: name.trim() || null, password: passwordForSave(), ...(wire.length > 0 ? { annotations: wire } : {}) },
          },
    [doc, chosen, picturePaths, outputDir, name, passwordForSave, wire],
  );
  const request = useMemo(() => build("rename"), [build]);
  const preview = useReviewPreview(request);
  const flow = useRunFlow({ kind: "pdf-pages", inputs: input, detail: wire.length > 0 ? `${plural(chosen.length, "page")}, ${plural(wire.length, "annotation")}` : plural(chosen.length, "page"), actionLabel: "Save", build, onStarted: onClose });
  const blocked = !!preview.error || (preview.review?.errors.length ?? 0) > 0 || cannotDraw > 0;

  return (
    <Dialog
      open
      title={mode === "copy" ? "Save a copy" : "Extract pages"}
      description={
        mode === "copy"
          ? `A new PDF with ${plural(chosen.length, "page")}, in the order shown. Your original is not changed.`
          : `A new PDF with the ${plural(chosen.length, "selected page")}. Your original is not changed.`
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void flow.begin()} disabled={flow.busy || blocked || preview.loading || chosen.length === 0 || name.trim().length === 0}>
            {flow.busy ? "Checking…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="card-stack">
        <Field label="File name" htmlFor="save-name" hint="“.pdf” is added for you.">
          <TextInput id="save-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} spellCheck={false} />
        </Field>
        <OutputFolder value={outputDir} onChange={setOutputDir} />
        {wire.length > 0 && <Callout tone="info">{plural(wire.length, "annotation")} will be drawn into the new PDF. They become part of the page and can't be edited afterwards, so keep this editor session if you may want to change them.</Callout>}
        {cannotDraw > 0 && (
          <Callout tone="error" title="Some text can't be saved">
            {plural(cannotDraw, "text annotation")} use{cannotDraw === 1 ? "s" : ""} characters the built-in PDF font can't draw (it covers Latin letters with accents and common punctuation, not Arabic, Chinese, emoji and so on). Edit or remove {cannotDraw === 1 ? "it" : "them"} to save.
          </Callout>
        )}
        <PreviewNotes preview={preview} startError={flow.error} />
      </div>
      {flow.dialog}
    </Dialog>
  );
}
