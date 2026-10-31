import { useState } from "react";
import type { ConflictPolicy, Review } from "../../lib/types";
import { basename, plural } from "../../lib/format";
import { Dialog } from "../../components/Dialog";
import { Button } from "../../components/Button";
import "./ReviewDialog.css";

const CHOICES: { value: ConflictPolicy; label: string; hint: string }[] = [
  { value: "rename", label: "Keep both", hint: "New files get a number, like “report (1).pdf”." },
  { value: "replace", label: "Replace the existing files", hint: "The files already in the folder will be overwritten." },
  { value: "skip", label: "Skip files that already exist", hint: "Existing files stay untouched; only new files are saved." },
];

interface Props {
  review: Review;
  actionLabel: string;
  onConfirm: (policy: ConflictPolicy) => void;
  onClose: () => void;
}

/** Shown only when the output folder already contains files with the same names. */
export function ReviewDialog({ review, actionLabel, onConfirm, onClose }: Props) {
  const [policy, setPolicy] = useState<ConflictPolicy>("rename");
  const shown = review.conflicts.slice(0, 5);
  const more = review.conflicts.length - shown.length;

  return (
    <Dialog
      open
      title={`${plural(review.conflicts.length, "file")} already exist${review.conflicts.length === 1 ? "s" : ""}`}
      description="Choose what should happen. Your original files are never changed."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onConfirm(policy)}>
            {actionLabel}
          </Button>
        </>
      }
    >
      <ul className="conflicts selectable">
        {shown.map((c) => (
          <li key={c} title={c}>
            {basename(c)}
          </li>
        ))}
        {more > 0 && <li className="conflicts__more">and {more} more</li>}
      </ul>
      <div role="radiogroup" aria-label="When a file already exists" className="choices">
        {CHOICES.map((c) => (
          <label key={c.value} className={`choice ${policy === c.value ? "choice--on" : ""}`}>
            <input type="radio" name="policy" value={c.value} checked={policy === c.value} onChange={() => setPolicy(c.value)} />
            <span>
              <strong>{c.label}</strong>
              <small>{c.hint}</small>
            </span>
          </label>
        ))}
      </div>
    </Dialog>
  );
}
