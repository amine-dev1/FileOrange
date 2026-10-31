/** A message fit to show a person, from whatever was thrown. */
export function messageOf(e: unknown): string {
  return e instanceof Error && e.message ? e.message : "Something went wrong.";
}
