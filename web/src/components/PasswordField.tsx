import { Field, TextInput } from "./ui";
import { t } from "../lib/i18n";

export function PasswordField({ id, value, onChange, hint }: { id: string; value: string; onChange: (v: string) => void; hint?: string }) {
  return (
    <Field label={t("Password (only if a file needs one)")} htmlFor={id} hint={t(hint ?? "Used for this job only and never saved or logged.")}>
      <TextInput id={id} type="password" autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}
