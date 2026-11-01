import { Camera, Check, ClipboardCopy, Download, ExternalLink, ImagePlus, Mail, MapPin, Phone, QrCode, ScanLine, ShieldCheck, Trash2, TriangleAlert, Wifi, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode, type TextareaHTMLAttributes } from "react";
import { useSearchParams } from "react-router-dom";
import { DropZone } from "../components/DropZone";
import { PageHeader } from "../components/ToolShell";
import { Badge, Button, Callout, Card, cx, Field, Segmented, Slider, Spinner, Switch, TextInput } from "../components/ui";
import { buildPayload, contrast, EMPTY_FORM, fileNameFor, isInverted, parseScanned, type QrForm, type QrKind, type Scanned } from "../lib/qr";
import { canvasBlob, findInVideo, makeMatrix, scanFile, selfCheck, toCanvas, toSvg, TooMuchData, type Ecc, type Found, type Look } from "../lib/qrImage";
import { useOnDrop } from "../state/DropProvider";
import type { FileItem } from "../lib/files";
import { t } from "../lib/i18n";

type Mode = "create" | "read";

export function QrPage() {
  const [params, setParams] = useSearchParams();
  const mode: Mode = params.get("mode") === "read" ? "read" : "create";
  const setMode = (m: Mode) => setParams(m === "read" ? { mode: "read" } : {}, { replace: true });
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="QR codes" subtitle="Make a QR code for a link, Wi-Fi, a contact and more, or read the text inside one. Everything happens in your browser: nothing is uploaded." />
      <div className="mb-6">
        <Segmented<Mode>
          label="What do you want to do?"
          value={mode}
          onChange={setMode}
          options={[
            { value: "create", label: "Create a QR code" },
            { value: "read", label: "Read a QR code" },
          ]}
        />
      </div>
      {mode === "create" ? <CreatePanel /> : <ReadPanel />}
    </div>
  );
}

// ---------------------------------------------------------------- small pieces

function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cx(
        "min-h-24 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100",
        className,
      )}
      {...rest}
    />
  );
}

function useCopied(): [string | null, (key: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = useCallback((key: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(key);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(null), 1800);
    });
  }, []);
  return [copied, copy];
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const canCopyImage = () => typeof window !== "undefined" && "ClipboardItem" in window && !!navigator.clipboard?.write;

// ---------------------------------------------------------------- create

const KINDS: { value: QrKind; label: string }[] = [
  { value: "url", label: "Link" },
  { value: "text", label: "Text" },
  { value: "wifi", label: "Wi-Fi" },
  { value: "contact", label: "Contact" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "sms", label: "SMS" },
];

const ECC: { value: Ecc; label: string }[] = [
  { value: "L", label: "Low (7%)" },
  { value: "M", label: "Medium (15%)" },
  { value: "Q", label: "High (25%)" },
  { value: "H", label: "Highest (30%)" },
];

const PX = [512, 1024, 2048];
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

type Check = "idle" | "checking" | "ok" | "bad";

function CreatePanel() {
  const uid = useId();
  const [kind, setKind] = useState<QrKind>("url");
  const [form, setForm] = useState<QrForm>(EMPTY_FORM);
  const [fg, setFg] = useState("#111111");
  const [bg, setBg] = useState("#ffffff");
  const [margin, setMargin] = useState(4);
  const [eccChoice, setEcc] = useState<Ecc>("M");
  const [px, setPx] = useState(1024);
  const [logo, setLogo] = useState<Look["logo"]>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [checked, setChecked] = useState<{ key: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, copy] = useCopied();
  const logoInput = useRef<HTMLInputElement>(null);

  const ecc: Ecc = logo ? "H" : eccChoice;
  const payload = useMemo(() => buildPayload(kind, form), [kind, form]);
  const look: Look = useMemo(() => ({ fg, bg, margin, logo }), [fg, bg, margin, logo]);
  const built = useMemo(() => {
    if (!payload.text) return { matrix: null, error: null as string | null };
    try {
      return { matrix: makeMatrix(payload.text, ecc), error: null };
    } catch (e) {
      return { matrix: null, error: e instanceof TooMuchData ? "This is too much for one QR code. Shorten it, or choose a lower error correction." : "The QR code couldn't be made." };
    }
  }, [payload.text, ecc]);
  const svg = useMemo(() => (built.matrix ? toSvg(built.matrix, look) : null), [built.matrix, look]);

  // Read the drawn code back, as a phone would. Waits for typing to pause.
  const checkKey = built.matrix && payload.text ? `${ecc}|${payload.text}|${fg}|${bg}|${margin}|${logo?.src.length ?? 0}` : null;
  useEffect(() => {
    const m = built.matrix;
    const text = payload.text;
    if (!m || !text || !checkKey) return;
    let live = true;
    const id = window.setTimeout(() => {
      selfCheck(m, look, text)
        .then((ok) => live && setChecked({ key: checkKey, ok }))
        .catch(() => live && setChecked({ key: checkKey, ok: false }));
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(id);
    };
  }, [built.matrix, look, payload.text, checkKey]);
  const check: Check = !checkKey ? "idle" : checked?.key !== checkKey ? "checking" : checked.ok ? "ok" : "bad";

  const set = <K extends keyof QrForm>(k: K, v: QrForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const ratio = contrast(fg, bg);
  const inverted = isInverted(fg, bg);
  const name = fileNameFor(kind, form);

  const png = async () => {
    if (!built.matrix) return null;
    return canvasBlob(await toCanvas(built.matrix, look, px));
  };
  const downloadPng = async () => {
    setBusy(true);
    try {
      const b = await png();
      if (b) saveBlob(b, `${name}.png`);
    } finally {
      setBusy(false);
    }
  };
  const downloadSvg = () => svg && saveBlob(new Blob([svg], { type: "image/svg+xml" }), `${name}.svg`);
  const copyImage = async () => {
    const b = await png();
    if (!b) return;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": b })]);
    copy("image", "");
  };

  const pickLogo = (file: File | undefined) => {
    setLogoError(null);
    if (!file) return;
    if (!/^image\/(png|jpeg|webp|svg\+xml|gif)$/.test(file.type)) return setLogoError("Choose a PNG, JPG, WebP or SVG picture.");
    if (file.size > MAX_LOGO_BYTES) return setLogoError("The logo must be smaller than 2 MB.");
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result);
      const img = new Image();
      img.onload = () => setLogo({ src, width: img.naturalWidth || 1, height: img.naturalHeight || 1 });
      img.onerror = () => setLogoError("The picture couldn't be read.");
      img.src = src;
    };
    reader.readAsDataURL(file);
  };

  const f = form;
  return (
    // On a phone: content, then the preview, then the design options. On a wide screen the preview stays beside both.
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:grid-rows-[auto_1fr]">
      <div className="lg:col-start-1 lg:row-start-1">
        <Card title={t("Content")}>
          <div className="flex flex-col gap-5">
            <Segmented<QrKind> label="Type of code" value={kind} onChange={setKind} options={KINDS} />

            {kind === "url" && (
              <Field label="Web address" htmlFor={`${uid}-url`} hint="Opens in the phone's browser when scanned.">
                <TextInput id={`${uid}-url`} type="url" inputMode="url" autoComplete="url" placeholder="https://example.com" value={f.url} onChange={(e) => set("url", e.target.value)} />
              </Field>
            )}

            {kind === "text" && (
              <Field label="Text" htmlFor={`${uid}-text`} hint="Any text: a note, a code, a message. Shorter text makes a simpler code that scans more easily.">
                <TextArea id={`${uid}-text`} value={f.text} onChange={(e) => set("text", e.target.value)} placeholder={t("Type the text to put in the code")} />
              </Field>
            )}

            {kind === "wifi" && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Network name (SSID)" htmlFor={`${uid}-ssid`}>
                  <TextInput id={`${uid}-ssid`} autoComplete="off" value={f.wifi.ssid} onChange={(e) => set("wifi", { ...f.wifi, ssid: e.target.value })} />
                </Field>
                <Field label="Password" htmlFor={`${uid}-wpw`}>
                  <TextInput id={`${uid}-wpw`} type="text" autoComplete="off" spellCheck={false} disabled={f.wifi.security === "nopass"} value={f.wifi.security === "nopass" ? "" : f.wifi.password} onChange={(e) => set("wifi", { ...f.wifi, password: e.target.value })} />
                </Field>
                <div className="sm:col-span-2">
                  <Segmented<QrForm["wifi"]["security"]>
                    label="Security"
                    value={f.wifi.security}
                    onChange={(v) => set("wifi", { ...f.wifi, security: v })}
                    options={[
                      { value: "WPA", label: "WPA / WPA2 / WPA3" },
                      { value: "WEP", label: "WEP (old)" },
                      { value: "nopass", label: "No password" },
                    ]}
                  />
                </div>
                <div className="sm:col-span-2">
                  <Switch id={`${uid}-hidden`} checked={f.wifi.hidden} onChange={(v) => set("wifi", { ...f.wifi, hidden: v })} label="Hidden network" description="Turn on if the network doesn't show up in the list of networks." />
                </div>
              </div>
            )}

            {kind === "contact" && (
              <div className="grid gap-4 sm:grid-cols-2">
                {(
                  [
                    ["first", "First name", "given-name", "text"],
                    ["last", "Last name", "family-name", "text"],
                    ["phone", "Phone", "tel", "tel"],
                    ["email", "Email", "email", "email"],
                    ["org", "Company", "organization", "text"],
                    ["title", "Job title", "organization-title", "text"],
                    ["website", "Website", "url", "url"],
                    ["address", "Address", "street-address", "text"],
                  ] as const
                ).map(([key, label, ac, type]) => (
                  <Field key={key} label={label} htmlFor={`${uid}-c-${key}`}>
                    <TextInput id={`${uid}-c-${key}`} type={type} autoComplete={ac} value={f.contact[key]} onChange={(e) => set("contact", { ...f.contact, [key]: e.target.value })} />
                  </Field>
                ))}
                <p className="text-xs text-slate-600 sm:col-span-2 dark:text-slate-400">{t("Scanning offers to save these details as a new contact.")}</p>
              </div>
            )}

            {kind === "email" && (
              <div className="flex flex-col gap-4">
                <Field label="Email address" htmlFor={`${uid}-to`}>
                  <TextInput id={`${uid}-to`} type="email" autoComplete="email" value={f.email.to} onChange={(e) => set("email", { ...f.email, to: e.target.value })} />
                </Field>
                <Field label="Subject (optional)" htmlFor={`${uid}-sub`}>
                  <TextInput id={`${uid}-sub`} value={f.email.subject} onChange={(e) => set("email", { ...f.email, subject: e.target.value })} />
                </Field>
                <Field label="Message (optional)" htmlFor={`${uid}-body`}>
                  <TextArea id={`${uid}-body`} value={f.email.body} onChange={(e) => set("email", { ...f.email, body: e.target.value })} />
                </Field>
              </div>
            )}

            {kind === "phone" && (
              <Field label="Phone number" htmlFor={`${uid}-tel`} hint="Include the country code (for example +33) so it works from any country.">
                <TextInput id={`${uid}-tel`} type="tel" autoComplete="tel" placeholder="+33 6 12 34 56 78" value={f.phone} onChange={(e) => set("phone", e.target.value)} />
              </Field>
            )}

            {kind === "sms" && (
              <div className="flex flex-col gap-4">
                <Field label="Phone number" htmlFor={`${uid}-smsn`} hint="Include the country code (for example +33) so it works from any country.">
                  <TextInput id={`${uid}-smsn`} type="tel" autoComplete="tel" value={f.sms.number} onChange={(e) => set("sms", { ...f.sms, number: e.target.value })} />
                </Field>
                <Field label="Message (optional)" htmlFor={`${uid}-smsm`}>
                  <TextArea id={`${uid}-smsm`} value={f.sms.message} onChange={(e) => set("sms", { ...f.sms, message: e.target.value })} />
                </Field>
              </div>
            )}

            {payload.problem && <Callout tone="warning">{t(payload.problem)}</Callout>}
          </div>
        </Card>
      </div>

      <div className="lg:sticky lg:top-6 lg:col-start-2 lg:row-span-2 lg:row-start-1">
        <Card title={t("Preview")}>
          <div className="flex flex-col gap-4">
            <div className="grid aspect-square place-items-center overflow-hidden rounded-xl border border-slate-200 bg-[repeating-conic-gradient(#f1f5f9_0_25%,#fff_0_50%)] bg-[length:20px_20px] dark:border-slate-700">
              {svg ? (
                <img data-testid="qr-preview" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} alt={t("QR code preview")} className="size-full" />
              ) : (
                <div className="flex flex-col items-center gap-2 p-6 text-center text-sm text-slate-500 dark:text-slate-400">
                  <QrCode className="size-10" aria-hidden />
                  {t(built.error ?? "Fill in the content and your code appears here.")}
                </div>
              )}
            </div>
            {built.error && <Callout tone="error">{t(built.error)}</Callout>}

            <div aria-live="polite" className="min-h-6 text-sm">
              {check === "checking" && (
                <span className="inline-flex items-center gap-2 text-slate-600 dark:text-slate-400">
                  <Spinner className="size-4" /> {t("Checking that it scans…")}
                </span>
              )}
              {check === "ok" && (
                <span className="inline-flex items-center gap-2 font-medium text-green-700 dark:text-green-400">
                  <ShieldCheck className="size-4" aria-hidden /> {t("Checked: this code scans correctly.")}
                </span>
              )}
              {check === "bad" && (
                <span className="inline-flex items-start gap-2 font-medium text-amber-700 dark:text-amber-300">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {t("This code may not scan. Try stronger colour contrast, a smaller logo or a higher error correction.")}
                </span>
              )}
            </div>

            <Segmented<string> label="PNG size" value={String(px)} onChange={(v) => setPx(Number(v))} options={PX.map((p) => ({ value: String(p), label: `${p} px` }))} />

            <div className="flex flex-wrap gap-2">
              <Button variant="primary" disabled={!svg || busy} icon={<Download className="size-4" aria-hidden />} onClick={() => void downloadPng()}>
                {t("Download PNG")}
              </Button>
              <Button disabled={!svg} icon={<Download className="size-4" aria-hidden />} onClick={downloadSvg}>
                {t("Download SVG")}
              </Button>
              {canCopyImage() && (
                <Button disabled={!svg} icon={copied === "image" ? <Check className="size-4" aria-hidden /> : <ClipboardCopy className="size-4" aria-hidden />} onClick={() => void copyImage().catch(() => undefined)}>
                  {t(copied === "image" ? "Copied" : "Copy image")}
                </Button>
              )}
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400">{t("SVG stays sharp at any size: best for print. PNG works everywhere.")}</p>

            {payload.text && (
              <details className="rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-800/60">
                <summary className="cursor-pointer font-medium text-slate-800 dark:text-slate-200">{t("What's inside the code")}</summary>
                <pre className="mt-2 max-h-40 overflow-auto font-mono text-xs break-all whitespace-pre-wrap text-slate-700 dark:text-slate-300">{payload.text}</pre>
              </details>
            )}
          </div>
        </Card>
      </div>

      <div className="lg:col-start-1 lg:row-start-2">
        <Card title={t("Design")}>
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap gap-6">
              <ColorField id={`${uid}-fg`} label="Code colour" value={fg} onChange={setFg} />
              <ColorField id={`${uid}-bg`} label="Background" value={bg} onChange={setBg} />
              <div className="flex items-end">
                <Button
                  size="sm"
                  onClick={() => {
                    setFg(bg);
                    setBg(fg);
                  }}
                >
                  {t("Swap colours")}
                </Button>
              </div>
            </div>
            {inverted ? (
              <Callout tone="warning">{t("The code is lighter than its background. Many phones can't read that: use a dark code on a light background.")}</Callout>
            ) : ratio < 4 ? (
              <Callout tone="warning">{t("The colours are too close. Use a darker code or a lighter background so phones can read it.")}</Callout>
            ) : null}

            <Field label="Logo in the middle (optional)" hint="Error correction is set to Highest so the code still scans with the logo on it.">
              <div className="flex flex-wrap items-center gap-3">
                {logo && <img src={logo.src} alt={t("Logo")} className="size-12 rounded-lg border border-slate-200 object-contain p-1 dark:border-slate-700" />}
                <Button size="sm" icon={<ImagePlus className="size-4" aria-hidden />} onClick={() => logoInput.current?.click()}>
                  {t(logo ? "Change logo" : "Add a logo")}
                </Button>
                {logo && (
                  <Button size="sm" icon={<Trash2 className="size-4" aria-hidden />} onClick={() => setLogo(null)}>
                    {t("Remove logo")}
                  </Button>
                )}
                <input
                  ref={logoInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  className="sr-only"
                  tabIndex={-1}
                  aria-label={t("Add a logo")}
                  onChange={(e) => {
                    pickLogo(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </div>
            </Field>
            {logoError && <Callout tone="error">{t(logoError)}</Callout>}

            <Segmented<Ecc>
              label="Error correction"
              value={ecc}
              onChange={setEcc}
              options={ECC.map((o) => ({ ...o, disabled: !!logo && o.value !== "H", reason: "A logo needs the highest error correction." }))}
            />
            <p className="-mt-3 text-xs text-slate-600 dark:text-slate-400">{t("How much of the code can be damaged or covered and still scan. Higher makes a denser code.")}</p>

            <Field label="Quiet zone" htmlFor={`${uid}-margin`} hint="The empty border around the code. Scanners need some; 4 is the standard.">
              <Slider id={`${uid}-margin`} label="Quiet zone" value={margin} min={0} max={8} onChange={setMargin} />
            </Field>
          </div>
        </Card>
      </div>

    </div>
  );
}

function ColorField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  // What's being typed in the hex box, until it is a valid colour (then the picker's value takes over).
  const [typing, setTyping] = useState<{ for: string; text: string } | null>(null);
  const draft = typing && typing.for === value ? typing.text : value;
  const setDraft = (text: string) => setTyping({ for: value, text });
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-slate-800 dark:text-slate-200">
        {t(label)}
      </label>
      <div className="flex items-center gap-2">
        <input id={id} type="color" value={value} onChange={(e) => onChange(e.target.value)} className="h-10 w-12 cursor-pointer rounded-lg border border-slate-300 bg-white p-1 dark:border-slate-700 dark:bg-slate-950" />
        <div className="w-28">
        <TextInput
          aria-label={t("{label}, hex code", { label: t(label) })}
          className="font-mono"
          value={draft}
          maxLength={7}
          onChange={(e) => {
            const v = e.target.value.trim();
            setDraft(v);
            if (/^#[0-9a-f]{6}$/i.test(v)) onChange(v.toLowerCase());
          }}
        />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- read

interface Result {
  id: number;
  name: string;
  /** An object URL (revoked when removed) or a data: URL from the camera. */
  image: string;
  width: number;
  height: number;
  found: Found | null;
  error?: string;
}

let nextResult = 1;
const IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg", "avif"];

function ReadPanel() {
  const [results, setResults] = useState<Result[]>([]);
  const [working, setWorking] = useState(0);
  const [camera, setCamera] = useState(false);
  const urls = useRef<string[]>([]);

  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const scan = useCallback(async (files: File[]) => {
    const pictures = files.slice(0, 20);
    setWorking((n) => n + pictures.length);
    for (const file of pictures) {
      const id = nextResult++;
      try {
        if (file.type && !file.type.startsWith("image/")) throw new Error("This isn't a picture. Choose a PNG, JPG or WebP image.");
        const opened = await scanFile(file);
        urls.current.push(opened.url);
        setResults((r) => [{ id, name: file.name || t("Pasted picture"), image: opened.url, width: opened.width, height: opened.height, found: opened.found }, ...r]);
      } catch (e) {
        setResults((r) => [{ id, name: file.name, image: "", width: 0, height: 0, found: null, error: e instanceof Error ? e.message : "The picture couldn't be read." }, ...r]);
      } finally {
        setWorking((n) => n - 1);
      }
    }
  }, []);

  const onItems = useCallback((items: FileItem[]) => void scan(items.map((i) => i.file)), [scan]);
  useOnDrop(onItems);

  // Paste a screenshot with Ctrl+V.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (files.length) {
        e.preventDefault();
        void scan(files);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [scan]);

  const remove = (r: Result) => {
    if (r.image.startsWith("blob:")) URL.revokeObjectURL(r.image);
    setResults((list) => list.filter((x) => x.id !== r.id));
  };
  const hasCamera = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

  return (
    <div className="flex flex-col gap-6">
      <DropZone
        local
        onFiles={onItems}
        accept={IMAGE_EXT}
        hint="or choose a picture or screenshot with a QR code. You can also paste one with Ctrl+V. Nothing is uploaded."
        chooseLabel="Choose pictures"
      />
      <div className="flex flex-wrap items-center gap-3">
        {hasCamera && !camera && (
          <Button icon={<Camera className="size-4" aria-hidden />} onClick={() => setCamera(true)}>
            {t("Scan with the camera")}
          </Button>
        )}
        {working > 0 && (
          <span className="inline-flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
            <Spinner className="size-4" /> {t("Looking for a QR code…")}
          </span>
        )}
      </div>
      {camera && (
        <CameraScanner
          onClose={() => setCamera(false)}
          onFound={(found, frame) => {
            setCamera(false);
            setResults((r) => [{ id: nextResult++, name: t("Camera"), image: frame.src, width: frame.width, height: frame.height, found }, ...r]);
          }}
        />
      )}
      <div aria-live="polite" className="flex flex-col gap-4">
        {results.map((r) => (
          <ResultCard key={r.id} result={r} onRemove={() => remove(r)} />
        ))}
      </div>
    </div>
  );
}

function CameraScanner({ onClose, onFound }: { onClose: () => void; onFound: (f: Found, frame: { src: string; width: number; height: number }) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(onFound);
  useEffect(() => {
    done.current = onFound;
  });

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: number | undefined;
    let stopped = false;
    const tick = () => {
      const v = video.current;
      if (stopped || !v) return;
      const hit = v.readyState >= 2 ? findInVideo(v) : null;
      if (hit) {
        const c = document.createElement("canvas");
        c.width = v.videoWidth;
        c.height = v.videoHeight;
        c.getContext("2d")?.drawImage(v, 0, 0);
        done.current(hit, { src: c.toDataURL("image/jpeg", 0.85), width: c.width, height: c.height });
        return;
      }
      timer = window.setTimeout(tick, 180);
    };
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false })
      .then((s) => {
        if (stopped) return s.getTracks().forEach((tr) => tr.stop());
        stream = s;
        const v = video.current;
        if (!v) return;
        v.srcObject = s;
        void v.play().catch(() => undefined);
        tick();
      })
      .catch((e: unknown) => {
        const name = e instanceof DOMException ? e.name : "";
        setError(name === "NotAllowedError" ? "Camera access was refused. Allow the camera for this site in your browser, or choose a picture instead." : name === "NotFoundError" ? "No camera was found on this device." : "The camera couldn't be started.");
      });
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, []);

  return (
    <Card
      title={t("Scan with the camera")}
      action={
        <Button size="sm" icon={<X className="size-4" aria-hidden />} onClick={onClose}>
          {t("Stop")}
        </Button>
      }
    >
      {error ? (
        <Callout tone="error">{t(error)}</Callout>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <div className="relative w-full max-w-md overflow-hidden rounded-xl bg-black">
            <video ref={video} muted playsInline className="block aspect-[4/3] w-full object-cover" aria-label={t("Camera view")} />
            <div className="pointer-events-none absolute inset-[18%] rounded-2xl border-4 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" aria-hidden />
            <ScanLine className="pointer-events-none absolute top-1/2 left-1/2 size-10 -translate-x-1/2 -translate-y-1/2 animate-pulse text-white/80" aria-hidden />
          </div>
          <p className="text-sm text-slate-600 dark:text-slate-400">{t("Hold the QR code inside the frame. It's read as soon as it's sharp.")}</p>
        </div>
      )}
    </Card>
  );
}

const KIND_LABEL: Record<Scanned["kind"], string> = {
  url: "Link",
  wifi: "Wi-Fi network",
  contact: "Contact",
  email: "Email",
  phone: "Phone number",
  sms: "SMS",
  geo: "Location",
  text: "Text",
};

function ResultCard({ result, onRemove }: { result: Result; onRemove: () => void }) {
  const [copied, copy] = useCopied();
  const text = result.found?.text ?? null;
  const info = useMemo(() => (text !== null ? parseScanned(text) : null), [text]);

  return (
    <Card>
      <div className="flex flex-col gap-5 sm:flex-row">
        {result.image && (
          <div className="relative self-start">
            <img src={result.image} alt={result.name} className="block max-h-48 w-auto max-w-full rounded-lg sm:max-w-56" />
            {result.found && (
              <svg viewBox={`0 0 ${result.width} ${result.height}`} preserveAspectRatio="none" className="pointer-events-none absolute inset-0 size-full" aria-hidden>
                <polygon points={result.found.corners.map((p) => `${p.x},${p.y}`).join(" ")} fill="rgba(234,88,12,0.15)" stroke="#ea580c" strokeWidth={Math.max(2, result.width / 120)} strokeLinejoin="round" />
              </svg>
            )}
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-xs text-slate-500 dark:text-slate-400">{result.name}</p>
              {info ? (
                <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100">
                  <Badge tone="green">{t("QR code found")}</Badge>
                  {t(KIND_LABEL[info.kind])}
                </h3>
              ) : (
                <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">{t(result.error ? "This picture couldn't be read" : "No QR code found")}</h3>
              )}
            </div>
            <Button size="sm" icon={<X className="size-4" aria-hidden />} onClick={onRemove} aria-label={t("Remove {name}", { name: result.name })}>
              {t("Remove")}
            </Button>
          </div>

          {!info && <p className="text-sm text-slate-600 dark:text-slate-400">{t(result.error ?? "Try a sharper picture, taken closer, with the whole code visible and nothing covering it.")}</p>}

          {info && text !== null && (
            <>
              <Details info={info} copied={copied} copy={copy} />
              <div>
                <p className="mb-1 text-xs font-medium text-slate-600 dark:text-slate-400">{t("Text in the code")}</p>
                <pre data-testid="qr-text" className="max-h-48 overflow-auto rounded-lg bg-slate-50 p-3 font-mono text-sm break-all whitespace-pre-wrap text-slate-800 dark:bg-slate-800/60 dark:text-slate-200">
                  {text}
                </pre>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" icon={copied === "all" ? <Check className="size-4" aria-hidden /> : <ClipboardCopy className="size-4" aria-hidden />} onClick={() => copy("all", text)}>
                  {t(copied === "all" ? "Copied" : "Copy text")}
                </Button>
                <Actions info={info} text={text} />
              </div>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-3 text-sm">
      <dt className="w-32 shrink-0 text-slate-500 dark:text-slate-400">{t(label)}</dt>
      <dd className="min-w-0 font-medium break-all text-slate-900 dark:text-slate-100">{children}</dd>
    </div>
  );
}

function Details({ info, copied, copy }: { info: Scanned; copied: string | null; copy: (k: string, v: string) => void }) {
  switch (info.kind) {
    case "url":
      return (
        <div className="flex flex-col gap-1.5">
          <dl>
            <Row label="Website">{info.host}</Row>
          </dl>
          <p className="text-xs text-slate-600 dark:text-slate-400">{t("Check the website name before you open a link from a QR code.")}</p>
        </div>
      );
    case "wifi":
      return (
        <dl className="flex flex-col gap-1.5">
          <Row label="Network name (SSID)">{info.ssid}</Row>
          <Row label="Password">
            {info.password ? (
              <span className="inline-flex flex-wrap items-center gap-2">
                <span className="font-mono">{info.password}</span>
                <Button size="sm" icon={copied === "pw" ? <Check className="size-4" aria-hidden /> : <ClipboardCopy className="size-4" aria-hidden />} onClick={() => copy("pw", info.password)}>
                  {t(copied === "pw" ? "Copied" : "Copy password")}
                </Button>
              </span>
            ) : (
              t("None")
            )}
          </Row>
          <Row label="Security">{info.security === "nopass" ? t("No password") : info.security}</Row>
          {info.hidden && <Row label="Hidden network">{t("Yes")}</Row>}
        </dl>
      );
    case "contact":
      return (
        <dl className="flex flex-col gap-1.5">
          {info.fields.map((f, i) => (
            <Row key={i} label={f.label}>
              {f.value}
            </Row>
          ))}
        </dl>
      );
    case "email":
      return (
        <dl className="flex flex-col gap-1.5">
          <Row label="To">{info.to}</Row>
          {info.subject && <Row label="Subject">{info.subject}</Row>}
          {info.body && <Row label="Message">{info.body}</Row>}
        </dl>
      );
    case "phone":
      return (
        <dl>
          <Row label="Phone number">{info.number}</Row>
        </dl>
      );
    case "sms":
      return (
        <dl className="flex flex-col gap-1.5">
          <Row label="Phone number">{info.number}</Row>
          {info.message && <Row label="Message">{info.message}</Row>}
        </dl>
      );
    case "geo":
      return (
        <dl>
          <Row label="Coordinates">
            {info.lat}, {info.lon}
          </Row>
        </dl>
      );
    case "text":
      return null;
  }
}

const linkBtn = "inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand-700 px-3 text-sm font-medium text-white shadow-sm hover:bg-brand-800";

function Actions({ info, text }: { info: Scanned; text: string }) {
  switch (info.kind) {
    case "url":
      return (
        <a className={linkBtn} href={info.url} target="_blank" rel="noopener noreferrer">
          <ExternalLink className="size-4" aria-hidden /> {t("Open link")}
        </a>
      );
    case "email":
      return (
        <a className={linkBtn} href={`mailto:${encodeURIComponent(info.to).replace(/%40/g, "@")}?subject=${encodeURIComponent(info.subject)}&body=${encodeURIComponent(info.body)}`}>
          <Mail className="size-4" aria-hidden /> {t("Write the email")}
        </a>
      );
    case "phone":
    case "sms":
      return (
        <a className={linkBtn} href={`${info.kind === "sms" ? "sms" : "tel"}:${info.number.replace(/[^\d+*#]/g, "")}`}>
          <Phone className="size-4" aria-hidden /> {t(info.kind === "sms" ? "Send an SMS" : "Call")}
        </a>
      );
    case "geo":
      return (
        <a className={linkBtn} href={`https://www.openstreetmap.org/?mlat=${info.lat}&mlon=${info.lon}#map=17/${info.lat}/${info.lon}`} target="_blank" rel="noopener noreferrer">
          <MapPin className="size-4" aria-hidden /> {t("Open the map")}
        </a>
      );
    case "contact":
      return /^BEGIN:VCARD/i.test(text.trim()) ? (
        <Button size="sm" variant="primary" icon={<Download className="size-4" aria-hidden />} onClick={() => saveBlob(new Blob([text], { type: "text/vcard" }), "contact.vcf")}>
          {t("Save the contact")}
        </Button>
      ) : null;
    case "wifi":
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400">
          <Wifi className="size-4" aria-hidden /> {t("On a phone, scanning the code with the camera app joins the network.")}
        </span>
      );
    default:
      return null;
  }
}
