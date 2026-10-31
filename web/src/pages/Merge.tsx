import { useMemo, useState } from "react";
import { ActionBar, PreviewNotes, ToolShell, useDropIntoSelection, useToolRows } from "../components/ToolShell";
import { FilesCard } from "../components/FilesCard";
import { PasswordField } from "../components/PasswordField";
import { Button, Card, Field, TextInput } from "../components/ui";
import { extensionsFor } from "../lib/capabilities";
import { formatBytes, plural } from "../lib/format";
import { toUploads, withExtension } from "../lib/run";
import { usePreview } from "../lib/usePreview";
import type { OperationReport } from "../lib/types";
import { useCapabilities } from "../state/CapabilitiesProvider";
import { useJobs } from "../state/JobsProvider";
import { useSelection } from "../state/SelectionProvider";

export function MergePage() {
  return (
    <ToolShell tool="pdf-merge" opId="pdf_merge" title="Merge PDFs" subtitle="Join several PDFs into one. Your originals are never changed.">
      {(op) => <MergeForm op={op} />}
    </ToolShell>
  );
}

function MergeForm({ op }: { op: OperationReport }) {
  const { caps } = useCapabilities();
  const { items } = useSelection();
  const { start } = useJobs();
  useDropIntoSelection();
  const { rows, valid } = useToolRows(op, items);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const options = useMemo(() => ({ output_name: name.trim() || null, password: password || null }), [name, password]);
  const ready = valid && items.length >= 2;
  const preview = usePreview(ready ? "pdf_merge" : null, options, items);

  return (
    <>
      <FilesCard title="PDFs to merge" rows={rows} accept={extensionsFor(caps!, ["pdf"])} hint="Choose two or more PDFs. They are joined in the order shown." noun="PDF" addLabel="Add PDFs" orderNote="merged top to bottom" />
      <Card title="Options">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="File name" htmlFor="merge-name" hint="“.pdf” is added for you. Leave blank for “merged”.">
            <TextInput id="merge-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="merged" maxLength={120} spellCheck={false} />
          </Field>
          <PasswordField id="merge-password" value={password} onChange={setPassword} hint="Tried on every protected PDF. Used for this job only. The merged PDF is not protected." />
        </div>
      </Card>
      <PreviewNotes preview={preview} />
      <ActionBar note={items.length ? `${plural(items.length, "PDF")} · ${formatBytes(items.reduce((n, i) => n + i.size, 0))}${items.length < 2 ? " · add at least one more" : ""}` : "Add at least two PDFs."}>
        <Button variant="primary" disabled={!ready || !preview.ok || preview.loading} onClick={() => start({ tool: "pdf-merge", operation: "pdf_merge", options, files: toUploads(items), title: withExtension(name, "pdf", "merged"), detail: plural(items.length, "PDF") })}>
          Merge
        </Button>
      </ActionBar>
    </>
  );
}
