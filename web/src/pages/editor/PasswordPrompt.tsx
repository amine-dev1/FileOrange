import { Lock } from "lucide-react";
import { useState } from "react";
import { Button, Field, TextInput } from "../../components/ui";
import { t } from "../../lib/i18n";

/** Asks for a PDF's password. The text lives only in this component and is cleared once sent. */
export function PasswordPrompt({ name, wrong, onSubmit, onCancel }: { name: string; wrong: boolean; onSubmit: (password: string) => void; onCancel: () => void }) {
  const [password, setPassword] = useState("");
  return (
    <form
      className="mx-auto flex max-w-sm flex-col gap-4 p-6 text-center"
      onSubmit={(e) => {
        e.preventDefault();
        const p = password;
        setPassword("");
        onSubmit(p);
      }}
    >
      <Lock className="mx-auto size-8 text-slate-400" aria-hidden />
      <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{t("This PDF is password-protected")}</h2>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        {t("Enter the password to open")} <strong className="break-all font-semibold">{name}</strong>{t(". It is used to open the file and to save your changes, and is never stored.")}
      </p>
      <div className="text-left">
        <Field label={t("Password")} htmlFor="pdf-password">
          <TextInput id="pdf-password" type="password" autoComplete="off" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={wrong || undefined} aria-describedby={wrong ? "pdf-password-error" : undefined} />
        </Field>
        {wrong && (
          <p id="pdf-password-error" role="alert" className="mt-1.5 text-sm text-red-700 dark:text-red-300">
            {t("That password isn't right. Try again.")}
          </p>
        )}
      </div>
      <div className="flex justify-center gap-2">
        <Button variant="primary" type="submit" disabled={password.length === 0}>
          {t("Open")}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t("Cancel")}
        </Button>
      </div>
    </form>
  );
}
