import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { runningInApp } from "../lib/tauri";
import "./WindowControls.css";

/** Minimise / maximise / close for the frameless window. Renders nothing when
 *  the OS is drawing its own title bar (tauri.conf.json `decorations: true`). */
export function WindowControls() {
  const [custom, setCustom] = useState(false);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!runningInApp()) return;
    const w = getCurrentWindow();
    let off: (() => void) | undefined;
    let dead = false;
    void (async () => {
      const decorated = await w.isDecorated();
      if (dead || decorated) return;
      setCustom(true);
      setMaximized(await w.isMaximized());
      off = await w.onResized(async () => setMaximized(await w.isMaximized()));
    })();
    return () => {
      dead = true;
      off?.();
    };
  }, []);

  if (!custom) return null;
  const w = getCurrentWindow();
  return (
    <div className="winctl">
      <button className="winctl__btn" aria-label="Minimize" onClick={() => void w.minimize()}>
        <Minus size={18} aria-hidden />
      </button>
      <button className="winctl__btn" aria-label={maximized ? "Restore" : "Maximize"} onClick={() => void w.toggleMaximize()}>
        {maximized ? <Copy size={15} aria-hidden /> : <Square size={15} aria-hidden />}
      </button>
      <button className="winctl__btn winctl__btn--close" aria-label="Close" onClick={() => void w.close()}>
        <X size={19} aria-hidden />
      </button>
    </div>
  );
}
