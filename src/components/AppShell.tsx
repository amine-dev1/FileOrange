import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { WindowControls } from "./WindowControls";
import "./AppShell.css";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <Sidebar />
      <div className="shell__main">
        <div className="shell__drag" data-tauri-drag-region />
        <WindowControls />
        <main className="shell__scroll" id="main">
          <div className="shell__content">{children}</div>
        </main>
      </div>
    </div>
  );
}
