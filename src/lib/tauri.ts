import { invoke, isTauri } from "@tauri-apps/api/core";
import type { AppErrorShape } from "./types";

export class AppError extends Error implements AppErrorShape {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const runningInApp = (): boolean => {
  try {
    return isTauri();
  } catch {
    return false;
  }
};

function toAppError(e: unknown): AppError {
  if (e && typeof e === "object" && "message" in e) {
    const { code, message } = e as { code?: unknown; message: unknown };
    return new AppError(typeof code === "string" ? code : "INTERNAL_ERROR", String(message));
  }
  if (typeof e === "string") return new AppError("INTERNAL_ERROR", e);
  return new AppError("INTERNAL_ERROR", "Something went wrong.");
}

/** The only place the UI calls into Rust. Errors always come back as AppError. */
export async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!runningInApp()) {
    throw new AppError("NOT_IN_APP", "OrangeFile has to run as a desktop app to process files.");
  }
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    throw toAppError(e);
  }
}

export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : toAppError(e).message;
}
