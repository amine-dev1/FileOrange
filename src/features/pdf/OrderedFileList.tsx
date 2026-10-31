import { ArrowDown, ArrowUp, X } from "lucide-react";
import type { FileRow } from "../../components/FileList";
import { FileTypeIcon } from "../../components/FileTypeIcon";
import { Button } from "../../components/Button";
import { extensionOf, formatBytes, plural } from "../../lib/format";

/** Files in the order they will be used, with controls to change it. Plain buttons, so it works by keyboard too. */
interface Props {
  rows: FileRow[];
  onMove: (path: string, delta: -1 | 1) => void;
  onRemove: (path: string) => void;
  onClear: () => void;
  disabled?: boolean;
  /** What the rows are called ("PDF", "picture"). */
  noun?: string;
  /** Said after the count, e.g. "merged top to bottom". */
  orderNote?: string;
  label?: string;
}

export function OrderedFileList({ rows, onMove, onRemove, onClear, disabled = false, noun = "PDF", orderNote = "merged top to bottom", label = "Files in merge order" }: Props) {
  const total = rows.reduce((n, r) => n + r.info.size, 0);
  return (
    <section className="filelist" aria-label={label}>
      <div className="filelist__head">
        <span>
          <strong>{plural(rows.length, noun)}</strong> · {formatBytes(total)} · {orderNote}
        </span>
        <Button variant="ghost" size="sm" onClick={onClear} disabled={disabled}>
          Clear all
        </Button>
      </div>
      <ol className="filelist__rows ordered">
        {rows.map(({ info, problem }, i) => (
          <li key={info.path} className={`filelist__row ${problem ? "filelist__row--problem" : ""}`}>
            <span className="ordered__num" aria-hidden>
              {i + 1}
            </span>
            <FileTypeIcon name={info.name} size={26} />
            <div className="filelist__text">
              <span className="filelist__name" title={info.path}>
                {info.name}
              </span>
              <span className="filelist__meta">{problem ?? `${extensionOf(info.name).toUpperCase() || noun.toUpperCase()} · ${formatBytes(info.size)}`}</span>
            </div>
            <button className="filelist__remove" onClick={() => onMove(info.path, -1)} disabled={disabled || i === 0} aria-label={`Move ${info.name} up`}>
              <ArrowUp size={16} aria-hidden />
            </button>
            <button className="filelist__remove" onClick={() => onMove(info.path, 1)} disabled={disabled || i === rows.length - 1} aria-label={`Move ${info.name} down`}>
              <ArrowDown size={16} aria-hidden />
            </button>
            <button className="filelist__remove" onClick={() => onRemove(info.path)} disabled={disabled} aria-label={`Remove ${info.name}`}>
              <X size={16} aria-hidden />
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
