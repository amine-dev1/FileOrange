import { Lock } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/Button";
import { Field, TextInput } from "../../components/Fields";

/** Asks for a PDF's password. The text lives only in this component and is cleared once sent. */
export function PdfPasswordPrompt({ name, wrong, onSubmit, onCancel }: { name: string; wrong: boolean; onSubmit: (password: string) => void; onCancel: () => void }) {
  const [password, setPassword] = useState("");
  return (
    <form
      className="pdf-password"
      onSubmit={(e) => {
        e.preventDefault();
        const p = password;
        setPassword("");
        onSubmit(p);
      }}
    >
      <Lock size={28} aria-hidden />
      <h2>This PDF is password-protected</h2>
      <p>
        Enter the password to open <strong className="pdf-password__name">{name}</strong>. It is used once to open the file and is never saved.
      </p>
      <Field label="Password" htmlFor="pdf-password">
        <TextInput id="pdf-password" type="password" autoComplete="off" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={wrong || undefined} aria-describedby={wrong ? "pdf-password-error" : undefined} />
      </Field>
      {wrong && (
        <p id="pdf-password-error" className="pdf-password__error" role="alert">
          That password isn't right. Try again.
        </p>
      )}
      <div className="pdf-password__actions">
        <Button variant="primary" type="submit" disabled={password.length === 0}>
          Open
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
