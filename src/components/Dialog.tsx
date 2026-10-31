import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import "./Dialog.css";

interface Props {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Modal dialog: traps focus, closes on Esc, restores focus to the opener. */
export function Dialog({ open, title, description, onClose, children, footer }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const body = ref.current?.querySelector<HTMLElement>(".dialog__body " + FOCUSABLE);
    (body ?? ref.current?.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    return () => previous?.focus();
  }, [open]);

  if (!open) return null;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    } else if (e.key === "Tab") {
      const els = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      if (els.length === 0) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div className="dialog-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby={description ? "dialog-desc" : undefined} onKeyDown={onKey}>
        <div className="dialog__head">
          <div>
            <h2 id="dialog-title">{title}</h2>
            {description && <p id="dialog-desc">{description}</p>}
          </div>
          <button className="dialog__close" onClick={onClose} aria-label="Close dialog">
            <X size={18} aria-hidden />
          </button>
        </div>
        <div className="dialog__body">{children}</div>
        <div className="dialog__foot">{footer}</div>
      </div>
    </div>
  );
}
