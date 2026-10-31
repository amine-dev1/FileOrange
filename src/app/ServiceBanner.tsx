import { useEffect, useState } from "react";
import { Callout } from "../components/Callout";
import { runningInApp } from "../lib/tauri";
import { jobsService } from "../services/jobsService";

/** Tells the user when files can't be processed (browser preview or the local
 *  processing service not answering). Renders nothing when all is well. */
export function ServiceBanner() {
  const [state, setState] = useState<"ok" | "browser" | "down">(() => (runningInApp() ? "ok" : "browser"));
  useEffect(() => {
    if (!runningInApp()) return;
    jobsService
      .apiStatus()
      .then((s) => setState(s.connected ? "ok" : "down"))
      .catch(() => setState("down"));
  }, []);
  if (state === "ok") return null;
  return state === "browser" ? (
    <Callout tone="warning" title="Preview mode">
      OrangeFile is open in a web browser, so files can't be picked or processed. Run the desktop app to use it.
    </Callout>
  ) : (
    <Callout tone="error" title="The processing service isn't running">
      OrangeFile can't process files right now. Close and reopen the app. If this keeps happening, restart your computer.
    </Callout>
  );
}
