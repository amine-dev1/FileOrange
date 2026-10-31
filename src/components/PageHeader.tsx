import type { ReactNode } from "react";
import "./PageHeader.css";

export function PageHeader({ title, subtitle, size = "md", actions }: { title: string; subtitle?: string; size?: "lg" | "md"; actions?: ReactNode }) {
  return (
    <header className={`page-header page-header--${size}`}>
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </header>
  );
}
