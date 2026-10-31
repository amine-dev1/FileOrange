import { getCurrentWebview } from "@tauri-apps/api/webview";
import { runningInApp } from "../lib/tauri";

export type DropEvent =
  | { type: "hover" }
  | { type: "leave" }
  | { type: "drop"; paths: string[] };

/** Subscribe to files dragged onto the window. Returns an unsubscribe function. */
export async function subscribeToDrops(handler: (e: DropEvent) => void): Promise<() => void> {
  if (!runningInApp()) return () => {};
  const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload;
    if (p.type === "enter" || p.type === "over") handler({ type: "hover" });
    else if (p.type === "leave") handler({ type: "leave" });
    else if (p.type === "drop") handler({ type: "drop", paths: p.paths });
  });
  return unlisten;
}
