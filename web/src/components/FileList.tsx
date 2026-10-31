import { ArrowDown, ArrowUp, X } from "lucide-react";
import { extensionOf, formatBytes, plural } from "../lib/format";
import type { FileItem } from "../lib/files";
import { FileIcon } from "./FileIcon";
import { Button, IconButton, cx } from "./ui";

export interface FileRow {
  item: FileItem;
  /** Why this file can't be used for the current tool. */
  problem?: string;
}

interface Props {
  rows: FileRow[];
  onRemove: (id: string) => void;
  onClear: () => void;
  /** Show numbers and move up / down buttons: the order is used. */
  ordered?: { note: string; onMove: (id: string, delta: -1 | 1) => void };
  noun?: string;
  label?: string;
  disabled?: boolean;
}

export function FileList({ rows, onRemove, onClear, ordered, noun = "file", label = "Selected files", disabled }: Props) {
  const total = rows.reduce((n, r) => n + r.item.size, 0);
  const List = ordered ? "ol" : "ul";
  return (
    <section aria-label={label} className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800">
      <div className="flex items-center justify-between gap-3 bg-slate-50 px-4 py-2 text-sm text-slate-600 dark:bg-slate-800/50 dark:text-slate-400">
        <span>
          <strong className="font-semibold text-slate-900 dark:text-slate-100">{plural(rows.length, noun)}</strong> · {formatBytes(total)}
          {ordered && <> · {ordered.note}</>}
        </span>
        <Button variant="ghost" size="sm" onClick={onClear} disabled={disabled}>
          Clear all
        </Button>
      </div>
      <List className="divide-y divide-slate-100 dark:divide-slate-800">
        {rows.map(({ item, problem }, i) => (
          <li key={item.id} className={cx("flex items-center gap-2 px-3 py-2.5 sm:gap-3 sm:px-4", problem && "bg-red-50/70 dark:bg-red-950/30")}>
            {ordered && (
              <span className="w-5 text-center text-sm font-semibold tabular-nums text-slate-400" aria-hidden>
                {i + 1}
              </span>
            )}
            <FileIcon name={item.name} className="max-sm:hidden" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100" title={item.relPath ?? item.name}>
                {item.relPath ?? item.name}
              </p>
              <p className={cx("truncate text-xs", problem ? "text-red-700 dark:text-red-300" : "text-slate-600 dark:text-slate-400")}>{problem ?? `${extensionOf(item.name).toUpperCase() || "FILE"} · ${formatBytes(item.size)}`}</p>
            </div>
            {ordered && (
              <>
                <IconButton label={`Move ${item.name} up`} disabled={disabled || i === 0} onClick={() => ordered.onMove(item.id, -1)}>
                  <ArrowUp className="size-4" aria-hidden />
                </IconButton>
                <IconButton label={`Move ${item.name} down`} disabled={disabled || i === rows.length - 1} onClick={() => ordered.onMove(item.id, 1)}>
                  <ArrowDown className="size-4" aria-hidden />
                </IconButton>
              </>
            )}
            <IconButton label={`Remove ${item.name}`} disabled={disabled} onClick={() => onRemove(item.id)}>
              <X className="size-4" aria-hidden />
            </IconButton>
          </li>
        ))}
      </List>
    </section>
  );
}
