import type { ReactNode } from "react";
import "./EmptyState.css";

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty__icon">{icon}</div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}
