import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle } from "lucide-react";
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { t } from "../lib/i18n";

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

// ---------------------------------------------------------------- buttons

type Variant = "primary" | "secondary" | "ghost" | "danger";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand-700 text-white shadow-sm hover:bg-brand-800 active:bg-brand-900 disabled:bg-slate-200 disabled:text-slate-600 dark:disabled:bg-slate-800 dark:disabled:text-slate-300",
  secondary: "border border-slate-300 bg-white text-slate-800 shadow-sm hover:bg-slate-50 disabled:text-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800 dark:disabled:text-slate-600",
  ghost: "text-slate-700 hover:bg-slate-200/70 disabled:text-slate-400 dark:text-slate-300 dark:hover:bg-slate-800 dark:disabled:text-slate-600",
  danger: "border border-red-300 bg-white text-red-700 hover:bg-red-50 disabled:text-red-300 dark:border-red-900 dark:bg-slate-900 dark:text-red-400 dark:hover:bg-red-950",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm" | "md";
  icon?: ReactNode;
}

export function Button({ variant = "secondary", size = "md", icon, className, children, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed",
        size === "sm" ? "h-8 px-3 text-sm" : "h-10 px-4 text-sm",
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

export function IconButton({ label, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={t(label)}
      title={t(label)}
      className={cx("inline-flex size-9 items-center justify-center rounded-lg text-slate-600 transition-colors hover:bg-slate-200/70 disabled:cursor-not-allowed disabled:text-slate-300 dark:text-slate-300 dark:hover:bg-slate-800 dark:disabled:text-slate-700", className)}
      {...rest}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- surfaces

export function Card({ title, action, children, className }: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900", className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5 dark:border-slate-800">
          {title && <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t(title)}</h2>}
          {action}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

const TONES = {
  info: { box: "border-sky-200 bg-sky-50 text-sky-950 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-100", Icon: Info, icon: "text-sky-600 dark:text-sky-400" },
  warning: { box: "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100", Icon: AlertTriangle, icon: "text-amber-600 dark:text-amber-400" },
  error: { box: "border-red-200 bg-red-50 text-red-950 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100", Icon: XCircle, icon: "text-red-600 dark:text-red-400" },
  success: { box: "border-emerald-200 bg-emerald-50 text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100", Icon: CheckCircle2, icon: "text-emerald-600 dark:text-emerald-400" },
};

export function Callout({ tone = "info", title, children, className }: { tone?: keyof typeof TONES; title?: string; children?: ReactNode; className?: string }) {
  const look = TONES[tone];
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cx("flex gap-3 rounded-xl border p-3.5 text-sm leading-relaxed", look.box, className)}>
      <look.Icon className={cx("mt-0.5 size-4.5 shrink-0", look.icon)} aria-hidden />
      <div className="min-w-0 [&_li]:mt-1 [&_ul]:list-disc [&_ul]:pl-5">
        {title && <p className="font-semibold">{t(title)}</p>}
        {children}
      </div>
    </div>
  );
}

export function Badge({ children, tone = "slate" }: { children: ReactNode; tone?: "slate" | "brand" | "green" | "red" | "amber" }) {
  const look = {
    slate: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
    brand: "bg-brand-100 text-brand-900 dark:bg-brand-900/40 dark:text-brand-200",
    green: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
    red: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
    amber: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
  }[tone];
  return <span className={cx("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium", look)}>{children}</span>;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx("size-5 animate-spin", className)} aria-hidden />;
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-slate-600 dark:text-slate-400">
      <div className="text-slate-400 dark:text-slate-600 dark:text-slate-400">{icon}</div>
      <h3 className="text-base font-semibold text-slate-800 dark:text-slate-200">{t(title)}</h3>
      {children && <p className="max-w-md text-sm">{children}</p>}
    </div>
  );
}

export function ProgressBar({ percent, label, indeterminate }: { percent: number; label: string; indeterminate?: boolean }) {
  return (
    <div
      role="progressbar"
      aria-label={t(label)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(percent)}
      className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"
    >
      <div
        className={cx("h-full rounded-full bg-brand-600 transition-[width] duration-300", indeterminate && "w-1/3 animate-pulse")}
        style={indeterminate ? undefined : { width: `${Math.max(2, Math.min(100, percent))}%` }}
      />
    </div>
  );
}

// ---------------------------------------------------------------- form controls

export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-slate-800 dark:text-slate-200">
        {t(label)}
      </label>
      {children}
      {hint && <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-400">{t(hint)}</p>}
    </div>
  );
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cx(
        "h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 aria-[invalid=true]:border-red-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100",
        className,
      )}
      {...rest}
    />
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  reason?: string;
}

export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: SegmentOption<T>[]; onChange: (v: T) => void }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <span id={id} className="text-sm font-medium text-slate-800 dark:text-slate-200">
        {t(label)}
      </span>
      <div role="radiogroup" aria-labelledby={id} className="inline-flex flex-wrap gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            disabled={o.disabled}
            title={o.disabled && o.reason ? t(o.reason) : undefined}
            onClick={() => onChange(o.value)}
            className={cx(
              "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
              o.value === value ? "bg-white text-brand-800 shadow-sm dark:bg-slate-950 dark:text-brand-300" : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100",
            )}
          >
            {t(o.label)}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Switch({ id, checked, onChange, label, description }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string; description?: string }) {
  return (
    <div className="flex items-start gap-3">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        onClick={() => onChange(!checked)}
        className={cx("relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors", checked ? "bg-brand-600" : "bg-slate-300 dark:bg-slate-700")}
      >
        <span className={cx("inline-block size-5 rounded-full bg-white shadow transition-transform", checked ? "translate-x-5.5" : "translate-x-0.5")} />
      </button>
      <div>
        <label id={`${id}-label`} htmlFor={id} className="text-sm font-medium text-slate-800 dark:text-slate-200">
          {t(label)}
        </label>
        {description && <p className="text-xs text-slate-600 dark:text-slate-400">{t(description)}</p>}
      </div>
    </div>
  );
}

export function Slider({ id, label, value, min, max, onChange, suffix = "" }: { id: string; label: string; value: number; min: number; max: number; onChange: (v: number) => void; suffix?: string }) {
  return (
    <div className="flex items-center gap-3">
      <input id={id} aria-label={t(label)} type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} className="h-2 w-full max-w-xs cursor-pointer accent-brand-600" />
      <output htmlFor={id} className="w-12 text-sm tabular-nums text-slate-700 dark:text-slate-300">
        {value}
        {suffix}
      </output>
    </div>
  );
}

// ---------------------------------------------------------------- dialog

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Modal dialog: traps focus, closes on Escape, gives focus back to what opened it. */
export function Dialog({ title, description, onClose, children, footer }: { title: string; description?: string; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>(`[data-dialog-body] ${FOCUSABLE}`) ?? ref.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    return () => previous?.focus();
  }, []);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    } else if (e.key === "Tab") {
      const els = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      if (els.length === 0) return;
      const [first, last] = [els[0], els[els.length - 1]];
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
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/50 p-4 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKey} className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl bg-white shadow-2xl dark:bg-slate-900">
        <header className="flex items-start justify-between gap-4 px-6 pt-5">
          <div>
            <h2 id={titleId} className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              {t(title)}
            </h2>
            {description && <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{t(description)}</p>}
          </div>
          <IconButton label={t("Close")} onClick={onClose} className="-mr-2 -mt-1">
            <X className="size-5" aria-hidden />
          </IconButton>
        </header>
        <div data-dialog-body className="overflow-y-auto px-6 py-4">
          {children}
        </div>
        <footer className="flex justify-end gap-2 border-t border-slate-100 px-6 py-4 dark:border-slate-800">{footer}</footer>
      </div>
    </div>
  );
}
