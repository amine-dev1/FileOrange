import { useMemo, useState } from "react";
import { ActionBar, PreviewNotes, ToolShell, useDropIntoSelection, useToolRows } from "../components/ToolShell";
import { FilesCard } from "../components/FilesCard";
import { Button, Card, Field, Segmented, Slider, Switch, TextInput } from "../components/ui";
import { extensionsFor, formatForFileName, formatLabel, labels } from "../lib/capabilities";
import { plural } from "../lib/format";
import { titleFor, toUploads } from "../lib/run";
import { usePreview } from "../lib/usePreview";
import type { OperationReport } from "../lib/types";
import { useCapabilities } from "../state/CapabilitiesProvider";
import { useJobs } from "../state/JobsProvider";
import { useSelection } from "../state/SelectionProvider";

type SizeMode = "none" | "percent" | "fit";
type Target = "keep" | "jpeg" | "png" | "webp";

const MAX_PX = 32768;
const SIZE_PRESETS = [
  { label: "Full HD", w: 1920, h: 1080 },
  { label: "HD", w: 1280, h: 720 },
  { label: "Square post", w: 1080, h: 1080 },
  { label: "Email", w: 800, h: 800 },
];
const KB_PRESETS = [100, 200, 500, 1000];

const whole = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : NaN);

export function ResizePage() {
  return (
    <ToolShell tool="resize" opId="resize_image" title="Resize and compress images" subtitle="Make pictures smaller in size or in file size. Your originals are never changed.">
      {(op) => <Form op={op} />}
    </ToolShell>
  );
}

function Form({ op }: { op: OperationReport }) {
  const { caps } = useCapabilities();
  const { items } = useSelection();
  const { start } = useJobs();
  useDropIntoSelection();
  const { rows, valid } = useToolRows(op, items);

  const [mode, setMode] = useState<SizeMode>("percent");
  const [percent, setPercent] = useState(50);
  const [width, setWidth] = useState("1920");
  const [height, setHeight] = useState("1920");
  const [aim, setAim] = useState(false);
  const [kb, setKb] = useState("500");
  const [target, setTarget] = useState<Target>("keep");
  const [quality, setQuality] = useState(80);
  const [keepInfo, setKeepInfo] = useState(false);

  const inputFormats = useMemo(() => items.map((i) => (caps ? (formatForFileName(caps, i.name)?.id ?? "") : "")).filter(Boolean), [caps, items]);
  // the formats that will be written
  const outFormats = target === "keep" ? [...new Set(inputFormats)] : [target];
  const lossyOut = outFormats.some((f) => f === "jpeg" || f === "webp");
  const pngOut = outFormats.includes("png");

  const w = whole(width);
  const h = whole(height);
  const wOk = width.trim() === "" || (w >= 1 && w <= MAX_PX);
  const hOk = height.trim() === "" || (h >= 1 && h <= MAX_PX);
  const fitOk = mode !== "fit" || (wOk && hOk && (width.trim() !== "" || height.trim() !== ""));
  const kbN = whole(kb);
  const kbOk = !aim || (kbN >= 1 && kbN <= 1_000_000);

  const options = useMemo(
    () => ({
      format: target,
      resize_mode: mode,
      resize_percent: percent,
      max_width: mode === "fit" && width.trim() ? w : null,
      max_height: mode === "fit" && height.trim() ? h : null,
      target_kb: aim ? kbN : null,
      quality,
      webp_mode: "lossy",
      keep_metadata: keepInfo,
    }),
    [target, mode, percent, width, height, w, h, aim, kbN, quality, keepInfo],
  );
  const nothingToDo = mode === "none" && !aim && target === "keep";
  const ready = valid && fitOk && kbOk && !nothingToDo;
  const preview = usePreview(ready ? "resize" : null, options, items);

  const summary = [mode === "percent" ? `${percent}%` : mode === "fit" ? `fit ${width || "any"}×${height || "any"}` : null, aim ? `≤ ${kbN} KB` : null, target !== "keep" ? `to ${formatLabel(caps!, target)}` : null].filter(Boolean).join(", ");
  const run = () => start({ tool: "resize", operation: "resize", options, files: toUploads(items), title: titleFor(items), detail: summary || null });

  return (
    <>
      <FilesCard rows={rows} accept={extensionsFor(caps!, op.inputs)} hint={`${labels(caps!, op.inputs)} pictures`} noun="picture" />

      <Card title="Size">
        <div className="flex flex-col gap-5">
          <Segmented<SizeMode>
            label="Picture size"
            value={mode}
            onChange={setMode}
            options={[
              { value: "percent", label: "By percentage" },
              { value: "fit", label: "Fit within" },
              { value: "none", label: "Keep the size" },
            ]}
          />
          {mode === "percent" && (
            <Field label="Percentage of the original size" htmlFor="rs-percent" hint="Both sides shrink by the same amount, so the proportions stay the same.">
              <div className="flex flex-wrap items-center gap-3">
                <Slider id="rs-percent" label="Percentage of the original size" value={percent} min={1} max={100} onChange={setPercent} suffix="%" />
                <div className="flex gap-1.5">
                  {[25, 50, 75].map((p) => (
                    <Button key={p} size="sm" variant={percent === p ? "primary" : "secondary"} onClick={() => setPercent(p)}>
                      {p}%
                    </Button>
                  ))}
                </div>
              </div>
            </Field>
          )}
          {mode === "fit" && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-4">
                <Field label="Maximum width (px)" htmlFor="rs-w">
                  <TextInput id="rs-w" inputMode="numeric" value={width} onChange={(e) => setWidth(e.target.value)} aria-invalid={!wOk || undefined} className="max-w-36" />
                </Field>
                <Field label="Maximum height (px)" htmlFor="rs-h">
                  <TextInput id="rs-h" inputMode="numeric" value={height} onChange={(e) => setHeight(e.target.value)} aria-invalid={!hOk || undefined} className="max-w-36" />
                </Field>
              </div>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Common sizes">
                {SIZE_PRESETS.map((p) => (
                  <Button
                    key={p.label}
                    size="sm"
                    onClick={() => {
                      setWidth(String(p.w));
                      setHeight(String(p.h));
                    }}
                  >
                    {p.label} ({p.w}×{p.h})
                  </Button>
                ))}
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                {fitOk ? "Pictures keep their proportions and are never made bigger. Leave a box empty for no limit on that side." : `Give a width, a height or both, from 1 to ${MAX_PX} pixels.`}
              </p>
            </div>
          )}
        </div>
      </Card>

      <Card title="File size and format">
        <div className="flex flex-col gap-5">
          <Segmented<Target>
            label="Save as"
            value={target}
            onChange={setTarget}
            options={[
              { value: "keep", label: "Same format" },
              { value: "jpeg", label: "JPG" },
              { value: "webp", label: "WebP" },
              { value: "png", label: "PNG" },
            ]}
          />
          <Switch id="rs-aim" checked={aim} onChange={setAim} label="Aim for a file size" description="Lowers the quality only as much as needed to fit. Works for JPG and WebP." />
          {aim && (
            <div className="flex flex-col gap-2">
              <Field label="Largest file size (KB)" htmlFor="rs-kb" hint="1000 KB is 1 MB.">
                <TextInput id="rs-kb" inputMode="numeric" value={kb} onChange={(e) => setKb(e.target.value)} aria-invalid={!kbOk || undefined} className="max-w-36" />
              </Field>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Common file sizes">
                {KB_PRESETS.map((k) => (
                  <Button key={k} size="sm" variant={kbN === k ? "primary" : "secondary"} onClick={() => setKb(String(k))}>
                    {k >= 1000 ? `${k / 1000} MB` : `${k} KB`}
                  </Button>
                ))}
              </div>
              {pngOut && <p className="text-xs text-amber-800 dark:text-amber-300">PNG keeps every pixel, so it can't aim for a size. Choose JPG or WebP to make PNG pictures fit.</p>}
            </div>
          )}
          {lossyOut && (
            <Field label={aim ? "Highest quality" : "Quality"} htmlFor="rs-q" hint={aim ? "The most it will use while still fitting." : "Higher looks better but makes bigger files."}>
              <Slider id="rs-q" label={aim ? "Highest quality" : "Quality"} value={quality} min={1} max={100} onChange={setQuality} />
            </Field>
          )}
          <Switch id="rs-meta" checked={keepInfo} onChange={setKeepInfo} label="Keep photo information" description="Camera details and location (EXIF). Off by default for privacy." />
        </div>
      </Card>

      <PreviewNotes preview={preview} />
      <ActionBar note={items.length ? (nothingToDo ? "Choose a smaller size, a file size or another format." : plural(items.length, "picture")) : "Add at least one picture."}>
        <Button variant="primary" onClick={run} disabled={!ready || !preview.ok || preview.loading}>
          Make smaller
        </Button>
      </ActionBar>
    </>
  );
}
