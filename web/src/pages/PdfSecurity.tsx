import { Eye, EyeOff } from "lucide-react";
import { useMemo, useState } from "react";
import { ActionBar, PreviewNotes, ToolShell, useDropIntoSelection, useToolRows } from "../components/ToolShell";
import { FilesCard } from "../components/FilesCard";
import { PasswordField } from "../components/PasswordField";
import { Button, Callout, Card, Field, Segmented, Switch, TextInput } from "../components/ui";
import { extensionsFor } from "../lib/capabilities";
import { formatBytes, plural } from "../lib/format";
import { t } from "../lib/i18n";
import { titleFor, toUploads } from "../lib/run";
import { usePreview } from "../lib/usePreview";
import type { OperationReport } from "../lib/types";
import { useCapabilities } from "../state/CapabilitiesProvider";
import { useJobs } from "../state/JobsProvider";
import { useSelection } from "../state/SelectionProvider";

const MAX_PASSWORD = 128;

/** A password box with a show/hide button. */
function SecretInput({ id, label, value, onChange, hint, invalid }: { id: string; label: string; value: string; onChange: (v: string) => void; hint?: string; invalid?: boolean }) {
  const [shown, setShown] = useState(false);
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <div className="flex max-w-sm gap-2">
        <TextInput id={id} type={shown ? "text" : "password"} autoComplete="new-password" value={value} maxLength={MAX_PASSWORD} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid || undefined} spellCheck={false} />
        <Button size="sm" variant="secondary" aria-label={t(shown ? "Hide password" : "Show password")} aria-pressed={shown} onClick={() => setShown((s) => !s)} icon={shown ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}>
          <span className="sr-only">{t(shown ? "Hide password" : "Show password")}</span>
        </Button>
      </div>
    </Field>
  );
}

function pdfNote(n: number, bytes: number) {
  return `${plural(n, "PDF")} · ${formatBytes(bytes)}`;
}

// ------------------------------------------------------------------ add a password

export function ProtectPdfPage() {
  return (
    <ToolShell tool="pdf-protect" opId="pdf_protect" title="Add a password to a PDF" subtitle="Only people with the password can open it. Your original is never changed.">
      {(op) => <ProtectForm op={op} />}
    </ToolShell>
  );
}

function ProtectForm({ op }: { op: OperationReport }) {
  const { caps } = useCapabilities();
  const { items } = useSelection();
  const { start } = useJobs();
  useDropIntoSelection();
  const { rows, valid } = useToolRows(op, items);
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [print, setPrint] = useState(true);
  const [copy, setCopy] = useState(true);
  const [edit, setEdit] = useState(true);
  const mismatch = again.length > 0 && again !== password;
  const pwOk = password.length > 0 && password === again && !/[\r\n]/.test(password);
  const options = useMemo(() => ({ password, allow_print: print, allow_copy: copy, allow_edit: edit }), [password, print, copy, edit]);
  const ready = valid && pwOk;
  const preview = usePreview(ready ? "pdf_protect" : null, options, items);
  const bytes = items.reduce((n, i) => n + i.size, 0);

  return (
    <>
      <FilesCard title="PDFs to protect" rows={rows} accept={extensionsFor(caps!, ["pdf"])} hint="Choose one or more PDFs. They all get the same password." noun="PDF" addLabel="Add PDFs" />
      <Card title="Password">
        <div className="flex flex-col gap-5">
          <SecretInput id="protect-password" label="Password" value={password} onChange={setPassword} hint="Needed to open the PDF. It isn't stored anywhere." />
          <SecretInput id="protect-again" label="Type it again" value={again} onChange={setAgain} invalid={mismatch} hint={mismatch ? "The two passwords are different." : undefined} />
          <Callout tone="warning">{t("Keep the password somewhere safe. Nobody, including us, can open the PDF or recover the password without it.")}</Callout>
        </div>
      </Card>
      <Card title="What people can do once it's open">
        <div className="flex flex-col gap-4">
          <Switch id="protect-print" checked={print} onChange={setPrint} label="Allow printing" />
          <Switch id="protect-copy" checked={copy} onChange={setCopy} label="Allow copying text and pictures" />
          <Switch id="protect-edit" checked={edit} onChange={setEdit} label="Allow changes" />
          <p className="text-xs text-slate-600 dark:text-slate-400">{t("PDF viewers are asked to respect these; most do, but they can't stop someone determined.")}</p>
        </div>
      </Card>
      <PreviewNotes preview={preview} />
      <ActionBar note={items.length ? pdfNote(items.length, bytes) : "Choose a PDF."}>
        <Button variant="primary" disabled={!ready || !preview.ok || preview.loading} onClick={() => start({ tool: "pdf-protect", operation: "pdf_protect", options, files: toUploads(items), title: titleFor(items), detail: null })}>
          {t("Protect")}
        </Button>
      </ActionBar>
    </>
  );
}

// ------------------------------------------------------------------ remove a password

export function UnlockPdfPage() {
  return (
    <ToolShell tool="pdf-unlock" opId="pdf_unlock" title="Remove a PDF password" subtitle="Save an unprotected copy of a PDF whose password you know.">
      {(op) => <UnlockForm op={op} />}
    </ToolShell>
  );
}

function UnlockForm({ op }: { op: OperationReport }) {
  const { caps } = useCapabilities();
  const { items } = useSelection();
  const { start } = useJobs();
  useDropIntoSelection();
  const { rows, valid } = useToolRows(op, items);
  const [password, setPassword] = useState("");
  const options = useMemo(() => ({ password }), [password]);
  const ready = valid && password.length > 0;
  const preview = usePreview(ready ? "pdf_unlock" : null, options, items);

  return (
    <>
      <FilesCard title="Protected PDFs" rows={rows} accept={extensionsFor(caps!, ["pdf"])} hint="Choose the PDFs to unlock. They must all use the same password." noun="PDF" addLabel="Add PDFs" />
      <Card title="Password">
        <div className="flex flex-col gap-4">
          <SecretInput id="unlock-password" label="Current password" value={password} onChange={setPassword} hint="You need to know it: this never guesses or cracks a password." />
          <p className="text-xs text-slate-600 dark:text-slate-400">{t("Only remove a password from documents you're allowed to.")}</p>
        </div>
      </Card>
      <PreviewNotes preview={preview} />
      <ActionBar note={items.length ? pdfNote(items.length, items.reduce((n, i) => n + i.size, 0)) : "Choose a PDF."}>
        <Button variant="primary" disabled={!ready || !preview.ok || preview.loading} onClick={() => start({ tool: "pdf-unlock", operation: "pdf_unlock", options, files: toUploads(items), title: titleFor(items), detail: null })}>
          {t("Remove password")}
        </Button>
      </ActionBar>
    </>
  );
}

// ------------------------------------------------------------------ compress

type Level = "lossless" | "balanced" | "strong";
const LEVEL_HELP: Record<Level, string> = {
  lossless: "Nothing visible changes. Gains are small, but nothing is lost.",
  balanced: "Pictures at about 150 dpi: fine on screens and for most printing.",
  strong: "Pictures at about 100 dpi: the smallest file, for email and uploads.",
};

export function CompressPdfPage() {
  return (
    <ToolShell tool="pdf-compress" opId="pdf_compress" title="Compress PDF" subtitle="Make PDFs smaller by resizing and recompressing the pictures inside them. Text stays sharp. Your original is never changed.">
      {(op) => <CompressForm op={op} />}
    </ToolShell>
  );
}

function CompressForm({ op }: { op: OperationReport }) {
  const { caps } = useCapabilities();
  const { items } = useSelection();
  const { start } = useJobs();
  useDropIntoSelection();
  const { rows, valid } = useToolRows(op, items);
  const [level, setLevel] = useState<Level>("balanced");
  const [password, setPassword] = useState("");
  const options = useMemo(() => ({ level, password: password || null }), [level, password]);
  const preview = usePreview(valid ? "pdf_compress" : null, options, items);

  return (
    <>
      <FilesCard title="PDFs to compress" rows={rows} accept={extensionsFor(caps!, ["pdf"])} hint="Choose one or more PDFs. Scans and PDFs full of photos shrink the most." noun="PDF" addLabel="Add PDFs" />
      <Card title="Options">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <Segmented<Level>
              label="Compression"
              value={level}
              onChange={setLevel}
              options={[
                { value: "lossless", label: "Light" },
                { value: "balanced", label: "Balanced" },
                { value: "strong", label: "Strong" },
              ]}
            />
            <p className="text-xs text-slate-600 dark:text-slate-400">{t(LEVEL_HELP[level])}</p>
          </div>
          <PasswordField id="compress-password" value={password} onChange={setPassword} hint="Only if the PDF is protected. The compressed copy isn't." />
        </div>
      </Card>
      <PreviewNotes preview={preview} />
      <ActionBar note={items.length ? pdfNote(items.length, items.reduce((n, i) => n + i.size, 0)) : "Choose a PDF."}>
        <Button variant="primary" disabled={!valid || !preview.ok || preview.loading} onClick={() => start({ tool: "pdf-compress", operation: "pdf_compress", options, files: toUploads(items), title: titleFor(items), detail: t(level === "lossless" ? "Light" : level === "balanced" ? "Balanced" : "Strong") })}>
          {t("Compress")}
        </Button>
      </ActionBar>
    </>
  );
}
