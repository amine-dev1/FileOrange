import type { ReactNode } from "react";
import "./Card.css";

export function Card({ title, action, children, className = "" }: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`} aria-label={title}>
      {(title || action) && (
        <div className="card__head">
          {title && <h2>{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
