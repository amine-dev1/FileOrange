import { useCallback, useMemo, useState } from "react";
import { Card } from "../../components/Card";
import { Button } from "../../components/Button";
import { Field, TextInput } from "../../components/Fields";
import { OutputFolder } from "../../components/OutputFolder";
import { CapabilityGate } from "../../components/CapabilityGate";
import { WorkflowPage } from "../workflow/WorkflowPage";
import { FilesCard } from "../workflow/FilesCard";
import { PreviewNotes } from "../workflow/PreviewNotes";
import { useWorkflowRows } from "../workflow/useWorkflowRows";
import { useReviewPreview } from "../workflow/useReviewPreview";
import { useRunFlow } from "../workflow/useRunFlow";
import { useSelection } from "../../app/SelectionProvider";
import { useSettings } from "../../app/SettingsProvider";
import { dialogService } from "../../services/dialogService";
import { dirname, formatBytes, plural } from "../../lib/format";
import type { ConflictPolicy, JobRequest } from "../../lib/types";

function CompressForm() {
  const { items, add } = useSelection();
  const { settings } = useSettings();
  const { rows, valid } = useWorkflowRows("compress", items);
  const [outputDir, setOutputDir] = useState<string | null>(settings.defaultOutputDir);
  const [name, setName] = useState("");

  const build = useCallback(
    (policy: ConflictPolicy): JobRequest | null =>
      items.length === 0
        ? null
        : {
            inputs: items.map((i) => i.path),
            output_dir: outputDir ?? dirname(items[0].path),
            conflict: policy,
            operation: { type: "compress", archive_name: name.trim() || null, include_folders: true },
          },
    [items, outputDir, name],
  );
  const request = useMemo(() => build("rename"), [build]);
  const preview = useReviewPreview(request);
  const flow = useRunFlow({ kind: "compress", inputs: items, actionLabel: "Compress", build });
  const blocked = !!preview.error || (preview.review?.errors.length ?? 0) > 0;
  const total = items.reduce((n, i) => n + i.size, 0);

  return (
    <>
      <FilesCard
        rows={rows}
        hint="Any files or folders"
        onBrowse={async () => add(await dialogService.pickFiles(undefined, "Choose files to compress"))}
        onBrowseFolders={async () => add(await dialogService.pickFolders("Choose folders to compress"))}
      />
      <Card title="Options">
        <div className="options-grid">
          <Field label="Archive name" htmlFor="archive-name" hint="Leave blank to name it after your files. “.zip” is added for you.">
            <TextInput id="archive-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={items.length === 1 ? items[0].name.replace(/\.[^.]+$/, "") : "archive"} maxLength={120} spellCheck={false} />
          </Field>
          <OutputFolder value={outputDir} onChange={setOutputDir} />
        </div>
      </Card>
      <PreviewNotes preview={preview} startError={flow.error} />
      <div className="action-bar action-bar--sticky">
        <span className="action-bar__note">{items.length > 0 ? `${plural(items.length, "item")} · ${formatBytes(total)} before compression` : "Add at least one file or folder."}</span>
        <Button variant="primary" onClick={() => void flow.begin()} disabled={!valid || flow.busy || blocked || preview.loading}>
          {flow.busy ? "Checking…" : "Compress"}
        </Button>
      </div>
      {flow.dialog}
    </>
  );
}

export function CompressPage() {
  return (
    <WorkflowPage kind="compress" title="Compress" subtitle="Pack files and folders into a single ZIP archive.">
      <CapabilityGate operationId="compress">{() => <CompressForm />}</CapabilityGate>
    </WorkflowPage>
  );
}
