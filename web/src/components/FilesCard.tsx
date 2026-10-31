import { Camera, Plus } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { toItem, type FileItem } from "../lib/files";
import { useSelection } from "../state/SelectionProvider";
import { DropZone } from "./DropZone";
import { FileList, type FileRow } from "./FileList";
import { Button, Card } from "./ui";
import { t } from "../lib/i18n";

interface Props {
  title?: string;
  rows: FileRow[];
  accept?: string[];
  hint?: string;
  folders?: boolean;
  noun?: string;
  addLabel?: string;
  chooseLabel?: string;
  /** Show the order (and move buttons); the text says how the order is used. */
  orderNote?: string;
  multiple?: boolean;
  /** Offer the phone's camera (shown on touch screens only). */
  camera?: boolean;
  children?: ReactNode;
}

/** "Take a photo": on phones and tablets the browser opens the camera. Each shot gets its own name, so several don't collide. */
function CameraButton({ onFile }: { onFile: (f: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <span className="hidden [@media(pointer:coarse)]:inline-flex">
      <Button size="sm" icon={<Camera className="size-4" aria-hidden />} onClick={() => input.current?.click()}>
        {t("Take a photo")}
      </Button>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        className="sr-only"
        tabIndex={-1}
        aria-label={t("Take a photo with the camera")}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          const stamp = new Date().toTimeString().slice(0, 8).replaceAll(":", "");
          const ext = f.type === "image/png" ? "png" : f.type === "image/webp" ? "webp" : "jpg";
          onFile(new File([f], `photo-${stamp}-${Math.random().toString(36).slice(2, 5)}.${ext}`, { type: f.type || "image/jpeg", lastModified: f.lastModified }));
        }}
      />
    </span>
  );
}

/** The selected files: a drop zone while there are none, the list (with "add more") once there are. */
export function FilesCard({ title = "Files", rows, accept, hint, folders, noun = "file", addLabel = "Add files", chooseLabel, orderNote, multiple = true, camera = false, children }: Props) {
  const { add, remove, clear, move, set } = useSelection();
  const more = useRef<HTMLInputElement>(null);
  const onFiles = multiple ? add : (items: FileItem[]) => set(items.slice(0, 1));
  return (
    <Card title={title}>
      <div className="flex flex-col gap-4">
        {rows.length === 0 ? (
          <>
            <DropZone compact onFiles={onFiles} accept={accept} hint={hint} folders={folders} multiple={multiple} chooseLabel={chooseLabel} />
            {camera && (
              <div>
                <CameraButton onFile={(f) => onFiles([toItem(f)])} />
              </div>
            )}
          </>
        ) : (
          <>
            <FileList rows={rows} onRemove={remove} onClear={clear} noun={noun} ordered={orderNote ? { note: orderNote, onMove: move } : undefined} />
            <div className="flex flex-wrap gap-2">
              {camera && <CameraButton onFile={(f) => onFiles([toItem(f)])} />}
              <Button size="sm" icon={<Plus className="size-4" aria-hidden />} onClick={() => more.current?.click()}>
                {t(multiple ? addLabel : "Choose another file")}
              </Button>
              <input
                ref={more}
                type="file"
                className="sr-only"
                tabIndex={-1}
                aria-label={t(addLabel)}
                multiple={multiple}
                accept={accept?.length ? accept.map((e) => `.${e}`).join(",") : undefined}
                onChange={(e) => {
                  if (e.target.files?.length) onFiles(Array.from(e.target.files).map((f) => toItem(f)));
                  e.target.value = "";
                }}
              />
            </div>
          </>
        )}
        {children}
      </div>
    </Card>
  );
}
