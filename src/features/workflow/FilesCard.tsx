import type { ReactNode } from "react";
import { FolderPlus, Plus } from "lucide-react";
import { Card } from "../../components/Card";
import { DropZone } from "../../components/DropZone";
import { FileList, type FileRow } from "../../components/FileList";
import { Button } from "../../components/Button";
import { useSelection } from "../../app/SelectionProvider";
import { useDragging } from "../../app/DropProvider";

interface Props {
  title?: string;
  rows: FileRow[];
  hint: string;
  onBrowse: () => void;
  onBrowseFolders?: () => void;
  addLabel?: string;
  children?: ReactNode;
}

export function FilesCard({ title = "Files", rows, hint, onBrowse, onBrowseFolders, addLabel = "Add files", children }: Props) {
  const { remove, clear, busy } = useSelection();
  const dragging = useDragging();
  return (
    <Card title={title}>
      <div className="card-stack">
        {rows.length === 0 ? (
          <DropZone
            compact
            dragging={dragging}
            busy={busy}
            onBrowse={onBrowse}
            hint={hint}
            extra={
              onBrowseFolders && (
                <Button variant="ghost" size="sm" icon={<FolderPlus size={16} aria-hidden />} onClick={onBrowseFolders} className="dz-extra">
                  Add a folder
                </Button>
              )
            }
          />
        ) : (
          <>
            <FileList rows={rows} onRemove={remove} onClear={clear} />
            <div className="action-bar" style={{ justifyContent: "flex-start" }}>
              <Button size="sm" icon={<Plus size={16} aria-hidden />} onClick={onBrowse} disabled={busy}>
                {addLabel}
              </Button>
              {onBrowseFolders && (
                <Button size="sm" icon={<FolderPlus size={16} aria-hidden />} onClick={onBrowseFolders} disabled={busy}>
                  Add folder
                </Button>
              )}
              {busy && <span className="action-bar__note">Reading files…</span>}
            </div>
          </>
        )}
        {children}
      </div>
    </Card>
  );
}
