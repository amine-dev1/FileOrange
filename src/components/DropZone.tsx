import type { ReactNode } from "react";
import { UploadFileGlyph } from "./brand";
import "./DropZone.css";

interface Props {
  onBrowse: () => void;
  /** True while a drag is hovering over the window. */
  dragging: boolean;
  busy?: boolean;
  compact?: boolean;
  /** Replaces the default "Drop files here or browse". */
  title?: string;
  hint?: string;
  extra?: ReactNode;
  className?: string;
}

export function DropZone({ onBrowse, dragging, busy = false, compact = false, title = "Drop files here or", hint = "Choose a file to see available tools.", extra, className = "" }: Props) {
  return (
    <div
      className={`dropzone ${dragging ? "dropzone--active" : ""} ${compact ? "dropzone--compact" : ""} ${className}`}
      role="group"
      aria-label="File drop zone"
      onClick={(e) => {
        if (e.target === e.currentTarget || !(e.target as HTMLElement).closest("button")) onBrowse();
      }}
    >
      <UploadFileGlyph width={compact ? 38 : 52} />
      <p className="dropzone__title">
        {dragging ? "Release to add your files" : title}
        {!dragging && (
          <>
            {" "}
            <button className="dropzone__link" onClick={onBrowse} disabled={busy}>
              browse
            </button>
          </>
        )}
      </p>
      <p className="dropzone__hint">{busy ? "Reading files…" : hint}</p>
      {extra}
    </div>
  );
}
