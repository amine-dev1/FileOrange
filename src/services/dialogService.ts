import { open } from "@tauri-apps/plugin-dialog";
import { runningInApp } from "../lib/tauri";

export interface FileFilter {
  name: string;
  extensions: string[];
}

async function pick(options: Parameters<typeof open>[0]): Promise<string[]> {
  if (!runningInApp()) return [];
  const result = await open(options);
  if (result == null) return [];
  return Array.isArray(result) ? result : [result];
}

export const dialogService = {
  pickFiles: (filters?: FileFilter[], title?: string) => pick({ multiple: true, directory: false, filters, title }),
  /** One file, or null if the dialog was cancelled. */
  async pickFile(filters?: FileFilter[], title?: string): Promise<string | null> {
    const r = await pick({ multiple: false, directory: false, filters, title });
    return r[0] ?? null;
  },
  pickFolders: (title?: string) => pick({ multiple: true, directory: true, title }),
  async pickFolder(title?: string): Promise<string | null> {
    const r = await pick({ multiple: false, directory: true, title });
    return r[0] ?? null;
  },
};
