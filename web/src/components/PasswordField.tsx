import { Field, TextInput } from "./ui";

export function PasswordField({ id, value, onChange, hint }: { id: string; value: string; onChange: (v: string) => void; hint?: string }) {
  return (
    <Field label="Password (only if a file needs one)" htmlFor={id} hint={hint ?? "Used for this job only and never saved or logged."}>
      <TextInput id={id} type="password" autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}
