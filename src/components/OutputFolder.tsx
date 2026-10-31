import { FolderOpen } from "lucide-react";
import { Button } from "./Button";
import { Field } from "./Fields";
import { dialogService } from "../services/dialogService";
import "./OutputFolder.css";

interface Props {
  /** null = next to the original files. */
  value: string | null;
  onChange: (dir: string | null) => void;
  disabled?: boolean;
  label?: string;
}

export function OutputFolder({ value, onChange, disabled, label = "Save to" }: Props) {
  const choose = async () => {
    const dir = await dialogService.pickFolder("Choose a folder to save to");
    if (dir) onChange(dir);
  };
  return (
    <Field label={label}>
      <div className="outfolder">
        <FolderOpen size={20} aria-hidden />
        <span className="outfolder__path selectable" title={value ?? undefined}>
          {value ?? "Same folder as the original files"}
        </span>
        {value && (
          <Button variant="ghost" size="sm" onClick={() => onChange(null)} disabled={disabled}>
            Reset
          </Button>
        )}
        <Button size="sm" onClick={() => void choose()} disabled={disabled}>
          Change…
        </Button>
      </div>
    </Field>
  );
}
