import { useMemo, useState } from "react";
import { ActionBar, PreviewNotes, ToolShell, useDropIntoSelection, useToolRows } from "../components/ToolShell";
import { FilesCard } from "../components/FilesCard";
import { PasswordField } from "../components/PasswordField";
import { Button, Card, Field, Segmented, TextInput } from "../components/ui";
import { extensionsFor } from "../lib/capabilities";
import { toUploads } from "../lib/run";
import { usePreview } from "../lib/usePreview";
import type { OperationReport } from "../lib/types";
import { useCapabilities } from "../state/CapabilitiesProvider";
import { useJobs } from "../state/JobsProvider";
import { useSelection } from "../state/SelectionProvider";
import { t } from "../lib/i18n";

type Mode = "every" | "ranges";

export function SplitPage() {
  return (
    <ToolShell tool="pdf-split" opId="pdf_split" title={t("Split a PDF")} subtitle={t("Cut one PDF into several. Your original is never changed.")}>
      {(op) => <SplitForm op={op} />}
    </ToolShell>
  );
}

function SplitForm({ op }: { op: OperationReport }) {
  const { caps } = useCapabilities();
  const { items } = useSelection();
  const { start } = useJobs();
  useDropIntoSelection();
  const base = useToolRows(op, items);
  // Split works on one file; any extra ones are marked so the reason is on screen.
  const rows = base.rows.map((r, i) => (i > 0 && !r.problem ? { ...r, problem: "Split works on one PDF at a time. Remove this one." } : r));
  const [mode, setMode] = useState<Mode>("every");
  const [every, setEvery] = useState("1");
  const [ranges, setRanges] = useState("");
  const [password, setPassword] = useState("");

  const n = Number.parseInt(every, 10);
  const inputOk = mode === "every" ? Number.isFinite(n) && n >= 1 : ranges.trim().length > 0;
  const options = useMemo(() => (mode === "every" ? { mode, every: n, password: password || null } : { mode, ranges, password: password || null }), [mode, n, ranges, password]);
  const ready = base.valid && items.length === 1 && inputOk;
  const preview = usePreview(ready ? "pdf_split" : null, options, items);

  return (
    <>
      <FilesCard title={t("PDF to split")} rows={rows} accept={extensionsFor(caps!, ["pdf"])} hint={t("Choose one PDF")} noun="PDF" multiple={false} />
      <Card title={t("Options")}>
        <div className="flex flex-col gap-5">
          <Segmented<Mode>
            label={t("Split by")}
            value={mode}
            onChange={setMode}
            options={[
              { value: "every", label: "Pages per file" },
              { value: "ranges", label: "Page ranges" },
            ]}
          />
          {mode === "every" ? (
            <Field label={t("Pages in each new PDF")} htmlFor="split-every" hint={t("1 makes one PDF per page. The last one holds whatever is left.")}>
              <TextInput id="split-every" type="number" min={1} max={50000} inputMode="numeric" value={every} onChange={(e) => setEvery(e.target.value)} aria-invalid={!inputOk || undefined} className="max-w-40" />
            </Field>
          ) : (
            <Field label={t("Page ranges")} htmlFor="split-ranges" hint={t("One new PDF for each range, for example 1-3, 4, 7-. A dash at the end means “to the last page”.")}>
              <TextInput id="split-ranges" value={ranges} onChange={(e) => setRanges(e.target.value)} placeholder="1-3, 4, 7-" spellCheck={false} />
            </Field>
          )}
          <PasswordField id="split-password" value={password} onChange={setPassword} hint={t("Used for this job only. The new PDFs are not protected.")} />
        </div>
      </Card>
      <PreviewNotes preview={preview} />
      <ActionBar note={items.length === 0 ? "Choose a PDF." : !inputOk ? (mode === "every" ? "Enter how many pages each file should have." : "Enter the page ranges.") : "The new PDFs come as a ZIP."}>
        <Button variant="primary" disabled={!ready || !preview.ok || preview.loading} onClick={() => start({ tool: "pdf-split", operation: "pdf_split", options, files: toUploads(items), title: items[0].name, detail: mode === "every" ? `every ${n}` : "ranges" })}>
          {t("Split")}
        </Button>
      </ActionBar>
    </>
  );
}
