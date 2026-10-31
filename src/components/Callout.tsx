import { AlertTriangle, Info, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import "./Callout.css";

export function Callout({ tone = "info", title, children }: { tone?: "info" | "warning" | "error"; title?: string; children?: ReactNode }) {
  const Icon = tone === "error" ? XCircle : tone === "warning" ? AlertTriangle : Info;
  return (
    <div className={`callout callout--${tone}`} role={tone === "error" ? "alert" : undefined}>
      <Icon size={18} aria-hidden />
      <div>
        {title && <strong>{title}</strong>}
        {children && <div className="callout__body">{children}</div>}
      </div>
    </div>
  );
}
