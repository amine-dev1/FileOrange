import "@fontsource-variable/dancing-script";
import "@fontsource-variable/caveat";
import { useEffect, useRef, useState } from "react";
import { Button, Callout, Dialog, Field, Segmented, Switch, TextInput } from "../../../components/ui";
import { contentBox, fitFontSize, whiteToTransparent } from "./signatureImage";
import { SIGNATURE_COLOR, type PendingSignature } from "./useAnnotations";
import { t } from "../../../lib/i18n";

const W = 440;
const H = 170;
const WARNING = "A signature added here is only a picture on the page. It is not a verified digital signature.";
const SAVED_KEY = "orangefile.signature.v1";
const MAX_UPLOAD_SIDE = 1600;

/** What the dialog gives back: pen strokes (drawn), or a picture with a transparent background (typed or from a photo). */
export type SignatureResult = { kind: "strokes"; signature: PendingSignature } | { kind: "picture"; file: File };

type Saved = { kind: "strokes"; signature: PendingSignature } | { kind: "png"; dataUrl: string };
type Mode = "draw" | "type" | "upload";
const FONTS = [
  { value: "dancing", label: "Flowing", family: "'Dancing Script Variable', cursive" },
  { value: "caveat", label: "Handwritten", family: "'Caveat Variable', cursive" },
] as const;
type FontKey = (typeof FONTS)[number]["value"];

function loadSaved(): Saved | null {
  try {
    const v = JSON.parse(localStorage.getItem(SAVED_KEY) ?? "null") as Saved | null;
    return v && (v.kind === "strokes" || v.kind === "png") ? v : null;
  } catch {
    return null;
  }
}
function store(v: Saved | null) {
  try {
    if (v) localStorage.setItem(SAVED_KEY, JSON.stringify(v));
    else localStorage.removeItem(SAVED_KEY);
  } catch {
    /* private mode: nothing is remembered */
  }
}

function drawStrokes(g: CanvasRenderingContext2D, strokes: [number, number][][], width: number) {
  g.strokeStyle = SIGNATURE_COLOR;
  g.fillStyle = SIGNATURE_COLOR;
  g.lineWidth = width;
  g.lineCap = "round";
  g.lineJoin = "round";
  for (const s of strokes) {
    if (s.length === 1) {
      g.beginPath();
      g.arc(s[0][0], s[0][1], width / 2, 0, Math.PI * 2);
      g.fill();
    } else {
      g.beginPath();
      s.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.stroke();
    }
  }
}

/** The part of a canvas that has something on it, as a PNG file (or null when it is empty). */
async function croppedPng(c: HTMLCanvasElement, name: string): Promise<{ file: File; dataUrl: string } | null> {
  const g = c.getContext("2d")!;
  const data = g.getImageData(0, 0, c.width, c.height);
  const box = contentBox(data.data, c.width, c.height, 6);
  if (!box) return null;
  const out = document.createElement("canvas");
  out.width = box.w;
  out.height = box.h;
  out.getContext("2d")!.drawImage(c, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  const blob = await new Promise<Blob | null>((r) => out.toBlob(r, "image/png"));
  if (!blob) return null;
  return { file: new File([blob], name, { type: "image/png" }), dataUrl: out.toDataURL("image/png") };
}

function SavedPreview({ saved }: { saved: Saved }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (saved.kind !== "strokes" || !ref.current) return;
    const g = ref.current.getContext("2d")!;
    const { strokes, aspect } = saved.signature;
    const h = 56;
    const w = Math.min(220, h * aspect);
    g.clearRect(0, 0, 240, 72);
    drawStrokes(g, strokes.map((s) => s.map(([x, y]) => [8 + x * w, 8 + y * (w / aspect)] as [number, number])), 1.6);
  }, [saved]);
  return saved.kind === "png" ? <img src={saved.dataUrl} alt={t("Your saved signature")} className="h-16 max-w-60 object-contain" /> : <canvas ref={ref} width={240} height={72} role="img" aria-label={t("Your saved signature")} className="h-16 w-auto" />;
}

/**
 * Make a signature to place on the page: draw it, type your name in a handwriting style, or use a photo of it on paper.
 * It can be remembered in this browser only. The result is a picture on the page, never a digital signature.
 */
export function SignatureDialog({ onUse, onClose }: { onUse: (s: SignatureResult) => void; onClose: () => void }) {
  const [saved, setSaved] = useState<Saved | null>(loadSaved);
  const [mode, setMode] = useState<Mode>("draw");
  const [remember, setRemember] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // draw
  const pad = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<[number, number][][]>([]);
  const [count, setCount] = useState(0);
  const drawing = useRef(false);
  // type
  const [name, setName] = useState("");
  const [font, setFont] = useState<FontKey>("dancing");
  const typed = useRef<HTMLCanvasElement>(null);
  // upload
  const [photo, setPhoto] = useState<HTMLCanvasElement | null>(null);
  const [cleanBackground, setCleanBackground] = useState(true);
  const shown = useRef<HTMLCanvasElement>(null);

  const redraw = () => {
    const g = pad.current?.getContext("2d");
    if (!g) return;
    g.clearRect(0, 0, W, H);
    drawStrokes(g, strokes.current, 2.4);
  };
  useEffect(() => {
    if (mode === "draw") redraw();
  }, [mode]);

  // typed name, drawn twice as large as shown so it stays sharp on the page
  useEffect(() => {
    if (mode !== "type") return;
    const c = typed.current;
    const g = c?.getContext("2d");
    if (!c || !g) return;
    const family = FONTS.find((f) => f.value === font)!.family;
    let live = true;
    const paint = () => {
      if (!live) return;
      g.clearRect(0, 0, c.width, c.height);
      const text = name.trim();
      if (!text) return;
      g.font = `100px ${family}`;
      const size = fitFontSize(g.measureText(text).width, 100, c.width - 60, 150, 30);
      g.font = `${size}px ${family}`;
      g.fillStyle = SIGNATURE_COLOR;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(text, c.width / 2, c.height / 2);
    };
    paint();
    void document.fonts?.load(`100px ${family}`, name || "Signature").then(paint, () => undefined);
    return () => {
      live = false;
    };
  }, [mode, name, font]);

  // the photo, with or without its background, scaled to fit the preview
  useEffect(() => {
    const c = shown.current;
    const g = c?.getContext("2d");
    if (!c || !g) return;
    g.clearRect(0, 0, c.width, c.height);
    if (!photo) return;
    const work = processedPhoto(photo, cleanBackground);
    const s = Math.min(c.width / work.width, c.height / work.height, 1);
    g.drawImage(work, (c.width - work.width * s) / 2, (c.height - work.height * s) / 2, work.width * s, work.height * s);
  }, [photo, cleanBackground, mode]);

  const pickPhoto = (file: File | undefined) => {
    setProblem(null);
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, MAX_UPLOAD_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.naturalWidth * s));
      c.height = Math.max(1, Math.round(img.naturalHeight * s));
      c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      setPhoto(c);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setProblem("That picture couldn't be read. Use a JPG, PNG or WebP photo of your signature.");
    };
    img.src = url;
  };

  const ready = mode === "draw" ? count > 0 : mode === "type" ? name.trim().length > 0 : photo !== null;

  const finish = async () => {
    setProblem(null);
    if (mode === "draw") {
      const all = strokes.current.flat();
      if (all.length === 0) return;
      const xs = all.map((p) => p[0]);
      const ys = all.map((p) => p[1]);
      const [l, t] = [Math.min(...xs), Math.min(...ys)];
      const w = Math.max(Math.max(...xs) - l, 4);
      const h = Math.max(Math.max(...ys) - t, 4);
      const signature: PendingSignature = { strokes: strokes.current.map((s) => s.map(([x, y]) => [(x - l) / w, (y - t) / h] as [number, number])), aspect: Math.min(10, Math.max(0.2, w / h)) };
      if (remember) store({ kind: "strokes", signature });
      onUse({ kind: "strokes", signature });
      return;
    }
    const source = mode === "type" ? typed.current : photo ? processedPhoto(photo, cleanBackground) : null;
    const png = source ? await croppedPng(source, "signature.png") : null;
    if (!png) {
      setProblem(mode === "upload" ? "No signature was found in this picture. Try a photo with dark ink on light paper, or turn off background removal." : "Type your name first.");
      return;
    }
    if (remember) store({ kind: "png", dataUrl: png.dataUrl });
    onUse({ kind: "picture", file: png.file });
  };

  const pickSaved = async () => {
    if (!saved) return;
    if (saved.kind === "strokes") return onUse({ kind: "strokes", signature: saved.signature });
    const blob = await (await fetch(saved.dataUrl)).blob();
    onUse({ kind: "picture", file: new File([blob], "signature.png", { type: "image/png" }) });
  };

  return (
    <Dialog
      title={t("Add your signature")}
      description={t("Draw it, type your name, or use a photo of your signature.")}
      onClose={onClose}
      footer={
        <>
          {mode === "draw" && (
            <Button
              variant="ghost"
              disabled={count === 0}
              onClick={() => {
                strokes.current = [];
                setCount(0);
                redraw();
              }}
            >
              {t("Clear")}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button variant="primary" onClick={() => void finish()} disabled={!ready}>
            {t("Use this signature")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {saved && (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/50">
            <div className="rounded-lg bg-white px-2 py-1">
              <SavedPreview saved={saved} />
            </div>
            <div className="flex flex-1 flex-wrap justify-end gap-2">
              <Button size="sm" variant="primary" onClick={() => void pickSaved()}>
                {t("Use my saved signature")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  store(null);
                  setSaved(null);
                }}
              >
                {t("Forget it")}
              </Button>
            </div>
          </div>
        )}

        <Segmented<Mode>
          label={t("How")}
          value={mode}
          onChange={(m) => {
            setProblem(null);
            setMode(m);
          }}
          options={[
            { value: "draw", label: "Draw" },
            { value: "type", label: "Type" },
            { value: "upload", label: "Photo" },
          ]}
        />

        {mode === "draw" && (
          <canvas
            ref={pad}
            width={W}
            height={H}
            role="img"
            aria-label={t("Signature pad: draw here with the mouse, a pen or your finger")}
            data-testid="signature-pad"
            className="aspect-[440/170] w-full max-w-[440px] cursor-crosshair touch-none rounded-xl border-2 border-dashed border-slate-300 bg-white dark:border-slate-600"
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              drawing.current = true;
              strokes.current.push([padPoint(e, pad.current!)]);
              setCount(strokes.current.length);
              redraw();
            }}
            onPointerMove={(e) => {
              if (!drawing.current) return;
              strokes.current[strokes.current.length - 1].push(padPoint(e, pad.current!));
              redraw();
            }}
            onPointerUp={() => (drawing.current = false)}
            onPointerCancel={() => (drawing.current = false)}
          />
        )}

        {mode === "type" && (
          <div className="flex flex-col gap-3">
            <Field label={t("Your name")} htmlFor="sig-name">
              <TextInput id="sig-name" value={name} maxLength={60} autoComplete="name" onChange={(e) => setName(e.target.value)} />
            </Field>
            <Segmented<FontKey> label={t("Style")} value={font} onChange={setFont} options={FONTS.map((f) => ({ value: f.value, label: f.label }))} />
            <canvas ref={typed} width={W * 2} height={H * 2} role="img" aria-label={name.trim() ? t("Your typed signature: {name}", { name: name.trim() }) : t("Your typed signature appears here")} data-testid="signature-typed" className="aspect-[440/170] w-full max-w-[440px] rounded-xl border-2 border-dashed border-slate-300 bg-white dark:border-slate-600" />
          </div>
        )}

        {mode === "upload" && (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-800 dark:text-slate-200">
              {t("Photo or scan of your signature")}
              <input type="file" accept="image/png,image/jpeg,image/webp" aria-label={t("Choose a photo of your signature")} onChange={(e) => pickPhoto(e.target.files?.[0])} className="text-sm font-normal file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:font-medium file:text-brand-800 dark:file:bg-brand-900/30 dark:file:text-brand-200" />
            </label>
            <Switch id="sig-clean" checked={cleanBackground} onChange={setCleanBackground} label={t("Remove the paper background")} description={t("Makes the white paper transparent, so only the ink shows on the page.")} />
            <canvas ref={shown} width={W} height={H} role="img" aria-label={t(photo ? "Your signature from the photo" : "The photo appears here")} data-testid="signature-photo" className="aspect-[440/170] w-full max-w-[440px] rounded-xl border-2 border-dashed border-slate-300 bg-[repeating-conic-gradient(#f1f5f9_0_25%,#fff_0_50%)] bg-[length:16px_16px] dark:border-slate-600" />
          </div>
        )}

        <Switch id="sig-remember" checked={remember} onChange={setRemember} label={t("Remember it on this device")} description={t("Kept only in this browser, so you can use it again next time. Never sent anywhere until you save a PDF with it.")} />
        {problem && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {t(problem)}
          </p>
        )}
        <Callout tone="warning">{t(WARNING)}</Callout>
      </div>
    </Dialog>
  );
}

function padPoint(e: React.PointerEvent, c: HTMLCanvasElement): [number, number] {
  const r = c.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
}

/** A copy of the photo, with the paper made transparent when asked. */
function processedPhoto(photo: HTMLCanvasElement, clean: boolean): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = photo.width;
  c.height = photo.height;
  const g = c.getContext("2d")!;
  g.drawImage(photo, 0, 0);
  if (clean) {
    const data = g.getImageData(0, 0, c.width, c.height);
    whiteToTransparent(data.data);
    g.putImageData(data, 0, 0);
  }
  return c;
}
