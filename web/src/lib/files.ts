import { extensionOf } from "./format";

/** A file the user picked or dropped. The bytes stay in the browser until a job is started. */
export interface FileItem {
  id: string;
  file: File;
  name: string;
  size: number;
  /** Set for files that came from a folder: the path inside it, for example `photos/2024/a.jpg`. */
  relPath?: string;
}

let counter = 0;
const nextId = () => `f${Date.now().toString(36)}${(counter++).toString(36)}`;

export function toItem(file: File, relPath?: string): FileItem {
  const rp = relPath ?? (file.webkitRelativePath || undefined);
  return { id: nextId(), file, name: file.name, size: file.size, relPath: rp || undefined };
}

/** The name a file is uploaded under: its folder path if it has one. */
export const uploadName = (f: FileItem) => f.relPath ?? f.name;

/** First 32 bytes, hex-encoded: enough for the server to decide what a file really is. */
export async function headHex(file: File): Promise<string> {
  const buf = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Files and folders from a drop. Folders are walked; the result keeps each file's path inside the folder it came from. */
export async function itemsFromDrop(dt: DataTransfer): Promise<FileItem[]> {
  const out: FileItem[] = [];
  const entries = Array.from(dt.items ?? [])
    .filter((i) => i.kind === "file")
    .map((i) => ({ entry: i.webkitGetAsEntry?.() ?? null, file: i.getAsFile() }));
  // getAsFile must be called while the event is being handled, which it was above.
  for (const { entry, file } of entries) {
    if (entry?.isDirectory) await walk(entry as FileSystemDirectoryEntry, entry.name, out);
    else if (file) out.push(toItem(file, ""));
  }
  if (entries.length === 0) for (const f of Array.from(dt.files)) out.push(toItem(f, ""));
  return out;
}

async function walk(dir: FileSystemDirectoryEntry, path: string, out: FileItem[]): Promise<void> {
  const reader = dir.createReader();
  const readBatch = () => new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
  for (;;) {
    const batch = await readBatch();
    if (batch.length === 0) break;
    for (const e of batch) {
      if (e.isDirectory) await walk(e as FileSystemDirectoryEntry, `${path}/${e.name}`, out);
      else if (e.isFile) {
        const file = await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej));
        out.push(toItem(file, `${path}/${e.name}`));
      }
    }
  }
}

/** Does the name look like it is one of these extensions? Only a hint: the server checks the content. */
export const hasExtension = (name: string, exts: string[]) => exts.includes(extensionOf(name));
