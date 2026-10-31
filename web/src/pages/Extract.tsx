import { useMemo, useState } from "react";
import { ActionBar, PreviewNotes, ToolShell, useDropIntoSelection, useToolRows } from "../components/ToolShell";
import { FilesCard } from "../components/FilesCard";
import { PasswordField } from "../components/PasswordField";
import { Button, Card, Switch } from "../components/ui";
import { extensionsFor, labels } from "../lib/capabilities";
import { plural } from "../lib/format";
import { titleFor, toUploads } from "../lib/run";
import { usePreview } from "../lib/usePreview";
import type { OperationReport } from "../lib/types";
import { useCapabilities } from "../state/CapabilitiesProvider";
import { useJobs } from "../state/JobsProvider";
import { useSelection } from "../state/SelectionProvider";
import { t } from "../lib/i18n";

export function ExtractPage() {
  return (
    <ToolShell tool="extract" opId="extract" title={t("Extract a ZIP")} subtitle={t("Open archives safely. Paths that try to escape the folder are refused.")}>
      {(op) => <ExtractForm op={op} />}
    </ToolShell>
  );
}

function ExtractForm({ op }: { op: OperationReport }) {
  const { caps } = useCapabilities();
  const { items } = useSelection();
  const { start } = useJobs();
  useDropIntoSelection();
  const { rows, valid } = useToolRows(op, items);
  const [subfolder, setSubfolder] = useState(true);
  const [password, setPassword] = useState("");
  const options = useMemo(() => ({ password: password || null, subfolder }), [password, subfolder]);
  const preview = usePreview(valid ? "extract" : null, options, items);

  return (
    <>
      <FilesCard title={t("Archives")} rows={rows} accept={extensionsFor(caps!, op.inputs)} hint={t("{formats} archives", { formats: labels(caps!, op.inputs) })} noun="archive" addLabel={t("Add archives")} />
      <Card title={t("Options")}>
        <div className="flex flex-col gap-5">
          <Switch id="subfolder" checked={subfolder} onChange={setSubfolder} label={t("Put files in a folder named after the archive")} description={t("Keeps the contents of each archive tidy and separate.")} />
          <PasswordField id="archive-password" value={password} onChange={setPassword} hint={t("Only for archives that are protected. Used for this job only and never saved or logged.")} />
        </div>
      </Card>
      <PreviewNotes preview={preview} />
      <ActionBar note={items.length ? plural(items.length, "archive") : "Add at least one archive."}>
        <Button variant="primary" disabled={!valid || !preview.ok || preview.loading} onClick={() => start({ tool: "extract", operation: "extract", options, files: toUploads(items), title: titleFor(items), detail: null })}>
          {t("Extract")}
        </Button>
      </ActionBar>
    </>
  );
}
