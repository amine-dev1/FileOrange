import type { InputHTMLAttributes, ReactNode } from "react";
import "./Fields.css";

export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <p className="field__hint">{hint}</p>}
    </div>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className="input" {...props} />;
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  reason?: string;
}

export function Segmented<T extends string>({ label, value, options, onChange, disabled }: { label: string; value: T; options: SegmentOption<T>[]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={o.value === value}
          className={`segmented__opt ${o.value === value ? "segmented__opt--on" : ""}`}
          disabled={disabled || o.disabled}
          title={o.disabled ? o.reason : undefined}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ id, checked, onChange, label, description, disabled }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string; description?: string; disabled?: boolean }) {
  return (
    <div className="toggle">
      <button id={id} role="switch" aria-checked={checked} aria-labelledby={`${id}-l`} disabled={disabled} className={`toggle__switch ${checked ? "toggle__switch--on" : ""}`} onClick={() => onChange(!checked)}>
        <span />
      </button>
      <div>
        <label id={`${id}-l`} htmlFor={id} className="toggle__label">
          {label}
        </label>
        {description && <p className="field__hint">{description}</p>}
      </div>
    </div>
  );
}

export function Slider({ id, label, value, min, max, onChange, disabled, suffix = "" }: { id: string; label: string; value: number; min: number; max: number; onChange: (v: number) => void; disabled?: boolean; suffix?: string }) {
  return (
    <div className="slider">
      <input id={id} aria-label={label} type="range" min={min} max={max} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} style={{ "--pct": `${((value - min) / (max - min)) * 100}%` } as React.CSSProperties} />
      <output htmlFor={id}>
        {value}
        {suffix}
      </output>
    </div>
  );
}
