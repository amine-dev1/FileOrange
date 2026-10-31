import { Plus } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { toItem, type FileItem } from "../lib/files";
import { useSelection } from "../state/SelectionProvider";
import { DropZone } from "./DropZone";
import { FileList, type FileRow } from "./FileList";
import { Button, Card } from "./ui";

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
  children?: ReactNode;
}

/** The selected files: a drop zone while there are none, the list (with "add more") once there are. */
export function FilesCard({ title = "Files", rows, accept, hint, folders, noun = "file", addLabel = "Add files", chooseLabel, orderNote, multiple = true, children }: Props) {
  const { add, remove, clear, move, set } = useSelection();
  const more = useRef<HTMLInputElement>(null);
  const onFiles = multiple ? add : (items: FileItem[]) => set(items.slice(0, 1));
  return (
    <Card title={title}>
      <div className="flex flex-col gap-4">
        {rows.length === 0 ? (
          <DropZone compact onFiles={onFiles} accept={accept} hint={hint} folders={folders} multiple={multiple} chooseLabel={chooseLabel} />
        ) : (
          <>
            <FileList rows={rows} onRemove={remove} onClear={clear} noun={noun} ordered={orderNote ? { note: orderNote, onMove: move } : undefined} />
            <div>
              <Button size="sm" icon={<Plus className="size-4" aria-hidden />} onClick={() => more.current?.click()}>
                {multiple ? addLabel : "Choose another file"}
              </Button>
              <input
                ref={more}
                type="file"
                className="sr-only"
                tabIndex={-1}
                aria-label={addLabel}
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
