import { FolderUp, UploadCloud } from "lucide-react";
import { useRef } from "react";
import { formatLimit } from "../lib/format";
import { toItem, type FileItem } from "../lib/files";
import { useCapabilities } from "../state/CapabilitiesProvider";
import { useDragging } from "../state/DropProvider";
import { Button, cx } from "./ui";
import { t } from "../lib/i18n";

interface Props {
  onFiles: (items: FileItem[]) => void;
  /** File extensions for the picker (a hint, the server checks the content). */
  accept?: string[];
  multiple?: boolean;
  folders?: boolean;
  hint?: string;
  compact?: boolean;
  chooseLabel?: string;
}

/** Choose files (or a folder) with a button, or drop them anywhere on the page. */
export function DropZone({ onFiles, accept, multiple = true, folders = false, hint, compact = false, chooseLabel = "Choose files" }: Props) {
  const files = useRef<HTMLInputElement>(null);
  const dir = useRef<HTMLInputElement>(null);
  const dragging = useDragging();
  // A hosted server has a per-file limit worth saying up front; the desktop engine's is so large it would only be noise.
  const max = useCapabilities().caps?.limits.max_file_bytes ?? null;
  const pick = (list: FileList | null) => {
    if (list && list.length) onFiles(Array.from(list).map((f) => toItem(f)));
  };
  return (
    <div
      className={cx(
        "flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed text-center transition-colors",
        compact ? "px-6 py-8" : "px-6 py-14",
        dragging ? "border-brand-600 bg-brand-50 dark:bg-brand-900/20" : "border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900",
      )}
    >
      <span className="grid size-12 place-items-center rounded-full bg-brand-100 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300">
        <UploadCloud className="size-6" aria-hidden />
      </span>
      <div>
        <p className="font-semibold text-slate-900 dark:text-slate-100">{t(dragging ? "Release to add" : "Drop files here")}</p>
        <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">{t(hint ?? "or choose them from your computer. Nothing is uploaded until you start.")}</p>
        {max !== null && max < 1_000_000_000 && <p className="mt-0.5 text-sm font-medium text-slate-700 dark:text-slate-300">{t("Up to {size} per file.", { size: formatLimit(max) })}</p>}
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button variant="primary" onClick={() => files.current?.click()}>
          {t(chooseLabel)}
        </Button>
        {folders && (
          <Button icon={<FolderUp className="size-4" aria-hidden />} onClick={() => dir.current?.click()}>
            {t("Choose a folder")}
          </Button>
        )}
      </div>
      <input
        ref={files}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-label={t(chooseLabel)}
        multiple={multiple}
        accept={accept?.length ? accept.map((e) => `.${e}`).join(",") : undefined}
        onChange={(e) => {
          pick(e.target.files);
          e.target.value = "";
        }}
      />
      {folders && (
        <input
          ref={dir}
          type="file"
          className="sr-only"
          tabIndex={-1}
          aria-label={t("Choose a folder")}
          // Not in React's types, but supported by every current browser.
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          onChange={(e) => {
            pick(e.target.files);
            e.target.value = "";
          }}
        />
      )}
    </div>
  );
}
