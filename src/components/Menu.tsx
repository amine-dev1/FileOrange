import { useEffect, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import "./Menu.css";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** Why it's disabled; shown as a tooltip. */
  reason?: string;
  danger?: boolean;
}

/** Row-actions button with a keyboard-navigable popup menu. */
export function Menu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open) wrap.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, [open]);

  const toggle = () => {
    if (!open && btn.current) {
      const r = btn.current.getBoundingClientRect();
      setUp(window.innerHeight - r.bottom < items.length * 38 + 24);
    }
    setOpen((o) => !o);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
      btn.current?.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const els = [...(wrap.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])];
      const i = els.indexOf(document.activeElement as HTMLElement);
      const n = e.key === "ArrowDown" ? (i + 1) % els.length : (i - 1 + els.length) % els.length;
      els[n]?.focus();
    }
  };

  return (
    <div className="menu" ref={wrap} onKeyDown={onKey}>
      <button ref={btn} className="menu__trigger" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
        <MoreHorizontal size={20} aria-hidden />
      </button>
      {open && (
        <div className={`menu__list ${up ? "menu__list--up" : ""}`} role="menu" aria-label={label}>
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              className={`menu__item ${it.danger ? "menu__item--danger" : ""}`}
              aria-disabled={it.disabled || undefined}
              title={it.disabled ? it.reason : undefined}
              onClick={() => {
                if (it.disabled) return;
                setOpen(false);
                btn.current?.focus();
                it.onSelect();
              }}
            >
              {it.icon}
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
