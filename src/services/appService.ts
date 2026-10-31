import { getVersion } from "@tauri-apps/api/app";
import { runningInApp } from "../lib/tauri";

export async function appVersion(): Promise<string | null> {
  if (!runningInApp()) return null;
  try {
    return await getVersion();
  } catch {
    return null;
  }
}
