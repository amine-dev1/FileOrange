import type { OptionSpec } from "../lib/types";
import { Field, Segmented, Slider, Switch } from "./ui";

/** Renders one backend-described option with the right control. */
export function OptionField({ spec, value, onChange }: { spec: OptionSpec; value: unknown; onChange: (value: unknown) => void }) {
  const k = spec.kind;
  const id = `opt-${spec.id}`;
  switch (k.type) {
    case "bool":
      return <Switch id={id} checked={Boolean(value)} onChange={onChange} label={spec.label} description={spec.help ?? undefined} />;
    case "int":
      return (
        <Field label={spec.label} htmlFor={id} hint={spec.help ?? undefined}>
          <Slider id={id} label={spec.label} value={Number(value)} min={k.min} max={k.max} onChange={onChange} />
        </Field>
      );
    case "choice":
      return (
        <div className="flex flex-col gap-1.5">
          <Segmented label={spec.label} value={String(value)} options={k.choices} onChange={onChange} />
          {spec.help && <p className="text-xs text-slate-600 dark:text-slate-400">{spec.help}</p>}
        </div>
      );
    case "color":
      return (
        <Field label={spec.label} htmlFor={id} hint={spec.help ?? undefined}>
          <div className="flex items-center gap-3">
            <input id={id} type="color" aria-label={`${spec.label} (colour picker)`} value={String(value)} onChange={(e) => onChange(e.target.value.toUpperCase())} className="size-10 cursor-pointer rounded-lg border border-slate-300 bg-transparent p-1 dark:border-slate-700" />
            <code className="text-sm text-slate-600 dark:text-slate-400">{String(value).toUpperCase()}</code>
          </div>
        </Field>
      );
    default:
      return null; // text and secret options have their own fields on their own pages
  }
}
