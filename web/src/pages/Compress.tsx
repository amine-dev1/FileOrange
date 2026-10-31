import { useMemo, useState } from "react";
import { ActionBar, PreviewNotes, ToolShell, useDropIntoSelection, useToolRows } from "../components/ToolShell";
import { FilesCard } from "../components/FilesCard";
import { Button, Card, Field, TextInput } from "../components/ui";
import { formatBytes, plural } from "../lib/format";
import { titleFor, toUploads, withExtension } from "../lib/run";
import { usePreview } from "../lib/usePreview";
import type { OperationReport } from "../lib/types";
import { useJobs } from "../state/JobsProvider";
import { useSelection } from "../state/SelectionProvider";
import { t } from "../lib/i18n";

export function CompressPage() {
  return (
    <ToolShell tool="compress" opId="compress" title={t("Make a ZIP")} subtitle={t("Pack files and folders into a single ZIP archive.")}>
      {(op) => <CompressForm op={op} />}
    </ToolShell>
  );
}

function CompressForm({ op }: { op: OperationReport }) {
  const { items } = useSelection();
  const { start } = useJobs();
  useDropIntoSelection();
  const { rows, valid } = useToolRows(op, items);
  const [name, setName] = useState("");
  const options = useMemo(() => ({ archive_name: name.trim() || null, include_folders: true }), [name]);
  const preview = usePreview(valid ? "compress" : null, options, items);
  const total = items.reduce((n, i) => n + i.size, 0);
  const folderCount = new Set(items.filter((i) => i.relPath).map((i) => i.relPath!.split("/")[0])).size;
  const placeholder = items.length === 1 ? items[0].name.replace(/\.[^.]+$/, "") : "archive";

  return (
    <>
      <FilesCard rows={rows} folders hint={t("Any files, or a whole folder")} noun="file" addLabel={t("Add files")} />
      <Card title={t("Options")}>
        <Field label={t("Archive name")} htmlFor="archive-name" hint={t("Leave blank to name it after your files. “.zip” is added for you.")}>
          <TextInput id="archive-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder} maxLength={120} spellCheck={false} />
        </Field>
      </Card>
      <PreviewNotes preview={preview} />
      <ActionBar note={items.length ? `${plural(items.length, "file")}${folderCount ? ` ${t("in {folders}", { folders: plural(folderCount, "folder") })}` : ""} · ${t("{size} before compression", { size: formatBytes(total) })}` : t("Add at least one file or folder.")}>
        <Button
          variant="primary"
          disabled={!valid || !preview.ok || preview.loading}
          onClick={() => start({ tool: "compress", operation: "compress", options, files: toUploads(items), title: withExtension(name, "zip", items.length === 1 ? placeholder : "archive"), detail: titleFor(items) })}
        >
          {t("Make the ZIP")}
        </Button>
      </ActionBar>
    </>
  );
}
