import { X } from "lucide-react";
import type { PathInfo } from "../lib/types";
import { extensionOf, formatBytes, plural } from "../lib/format";
import { FileTypeIcon } from "./FileTypeIcon";
import { Button } from "./Button";
import "./FileList.css";

export interface FileRow {
  info: PathInfo;
  /** Problem with this file for the current workflow. */
  problem?: string;
}

interface Props {
  rows: FileRow[];
  onRemove: (path: string) => void;
  onClear: () => void;
  disabled?: boolean;
}

function kindLabel(i: PathInfo): string {
  if (i.is_dir) return `Folder · ${plural(i.file_count, "file")}`;
  const ext = extensionOf(i.name);
  return ext ? `${ext.toUpperCase()} file` : "File";
}

export function FileList({ rows, onRemove, onClear, disabled = false }: Props) {
  const total = rows.reduce((n, r) => n + r.info.size, 0);
  return (
    <section className="filelist" aria-label="Selected files">
      <div className="filelist__head">
        <span>
          <strong>{plural(rows.length, "item")}</strong> · {formatBytes(total)}
        </span>
        <Button variant="ghost" size="sm" onClick={onClear} disabled={disabled}>
          Clear all
        </Button>
      </div>
      <ul className="filelist__rows">
        {rows.map(({ info, problem }) => (
          <li key={info.path} className={`filelist__row ${problem ? "filelist__row--problem" : ""}`}>
            <FileTypeIcon name={info.name} isDir={info.is_dir} size={26} />
            <div className="filelist__text">
              <span className="filelist__name" title={info.path}>
                {info.name}
              </span>
              <span className="filelist__meta">{problem ?? kindLabel(info)}</span>
            </div>
            <span className="filelist__size">{formatBytes(info.size)}</span>
            <button className="filelist__remove" onClick={() => onRemove(info.path)} disabled={disabled} aria-label={`Remove ${info.name}`}>
              <X size={16} aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
