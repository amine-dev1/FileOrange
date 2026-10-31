import type { OptionSpec } from "../../lib/types";
import { Field, Segmented, Slider, Toggle } from "../../components/Fields";
import "./OptionField.css";

interface Props {
  spec: OptionSpec;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
}

/** Renders one backend-described option with the right control. */
export function OptionField({ spec, value, onChange, disabled }: Props) {
  const k = spec.kind;
  switch (k.type) {
    case "bool":
      return <Toggle id={`opt-${spec.id}`} checked={Boolean(value)} onChange={onChange} label={spec.label} description={spec.help ?? undefined} disabled={disabled} />;
    case "int":
      return (
        <Field label={spec.label} htmlFor={`opt-${spec.id}`} hint={spec.help ?? undefined}>
          <Slider id={`opt-${spec.id}`} label={spec.label} value={Number(value)} min={k.min} max={k.max} onChange={onChange} disabled={disabled} />
        </Field>
      );
    case "choice":
      return (
        <Field label={spec.label} hint={spec.help ?? undefined}>
          <Segmented label={spec.label} value={String(value)} options={k.choices} onChange={onChange} disabled={disabled} />
        </Field>
      );
    case "color":
      return (
        <Field label={spec.label} htmlFor={`opt-${spec.id}`} hint={spec.help ?? undefined}>
          <div className="colour-field">
            <input id={`opt-${spec.id}`} type="color" aria-label={`${spec.label} (colour picker)`} value={String(value)} disabled={disabled} onChange={(e) => onChange(e.target.value.toUpperCase())} />
            <code className="selectable">{String(value).toUpperCase()}</code>
          </div>
        </Field>
      );
    default:
      return null; // text and secret options have dedicated controls on their own pages
  }
}
