import type { Preview } from "./useReviewPreview";
import { Callout } from "../../components/Callout";
import { plural } from "../../lib/format";

/** Warnings, conflicts and blocking problems from the dry run. */
export function PreviewNotes({ preview, startError }: { preview: Preview; startError?: string | null }) {
  const { review, error } = preview;
  return (
    <>
      {startError && <Callout tone="error" title="Couldn't start">{startError}</Callout>}
      {error && <Callout tone="error" title="Can't use this selection">{error}</Callout>}
      {review?.errors.map((e) => (
        <Callout key={e} tone="error">
          {e}
        </Callout>
      ))}
      {review && review.warnings.length > 0 && (
        <Callout tone="warning" title="Good to know">
          <ul>
            {review.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Callout>
      )}
      {review && review.conflicts.length > 0 && (
        <Callout tone="info">
          {plural(review.conflicts.length, "file")} with the same name already exist in the destination. You'll choose what to do before anything is written.
        </Callout>
      )}
    </>
  );
}
