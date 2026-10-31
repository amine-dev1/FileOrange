import { Clock, Download, FileText, Folder, House, RefreshCw, Settings, type LucideIcon } from "lucide-react";
import { sidebarItemFor, useNav, type Route } from "../app/NavProvider";
import { LogoMark } from "./brand";
import "./Sidebar.css";

const ITEMS: { route: Route; label: string; Icon: LucideIcon; accent?: boolean }[] = [
  { route: "dashboard", label: "Dashboard", Icon: House },
  { route: "convert", label: "Convert", Icon: RefreshCw },
  { route: "pdf-tools", label: "PDF Tools", Icon: FileText, accent: true },
  { route: "compress", label: "Compress", Icon: Download },
  { route: "extract", label: "Extract", Icon: Folder },
  { route: "jobs", label: "Recent Jobs", Icon: Clock },
  { route: "settings", label: "Settings", Icon: Settings },
];

export function Sidebar() {
  const { route, go } = useNav();
  const current = sidebarItemFor(route);
  return (
    <aside className="sidebar">
      <div className="sidebar__brand" data-tauri-drag-region>
        <LogoMark size={30} />
        {/* The wordmark is a logotype (exempt from text-contrast rules), so it is an image with a text alternative. */}
        <svg className="sidebar__word" width="124" height="28" viewBox="0 0 124 28" role="img" aria-label="OrangeFile" data-tauri-drag-region>
          <text x="0" y="21" fontSize="21" fontWeight="700" letterSpacing="-0.4" fontFamily="inherit">
            <tspan fill="#F47B20">Orange</tspan>
            <tspan fill="#1c1e22">File</tspan>
          </text>
        </svg>
      </div>
      <nav aria-label="Main">
        <ul className="sidebar__list">
          {ITEMS.map(({ route: r, label, Icon, accent }) => (
            <li key={r}>
              <button className={`nav-item ${current === r ? "nav-item--active" : ""} ${accent ? "nav-item--accent" : ""}`} aria-current={current === r ? "page" : undefined} onClick={() => go(r)}>
                <Icon size={21} strokeWidth={current === r ? 2.2 : 1.8} aria-hidden />
                {label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}
