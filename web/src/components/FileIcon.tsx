import { File, FileArchive, FileImage, FileSpreadsheet, FileText, Folder, Presentation } from "lucide-react";
import { extensionOf } from "../lib/format";
import { cx } from "./ui";

const KINDS: [string[], typeof File, string][] = [
  [["jpg", "jpeg", "png", "webp", "gif", "bmp"], FileImage, "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300"],
  [["pdf"], FileText, "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"],
  [["zip", "7z", "rar", "tar", "gz"], FileArchive, "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"],
  [["doc", "docx", "odt", "rtf"], FileText, "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"],
  [["xls", "xlsx", "ods", "csv"], FileSpreadsheet, "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"],
  [["ppt", "pptx", "odp"], Presentation, "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300"],
];

export function FileIcon({ name, folder = false, size = 36, className }: { name: string; folder?: boolean; size?: number; className?: string }) {
  const ext = extensionOf(name);
  const [, Icon, tone] = folder ? [[], Folder, "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"] : (KINDS.find(([e]) => e.includes(ext)) ?? [[], File, "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"]);
  return (
    <span className={cx("grid shrink-0 place-items-center rounded-lg", tone, className)} style={{ width: size, height: size }} aria-hidden>
      <Icon size={Math.round(size * 0.5)} />
    </span>
  );
}
