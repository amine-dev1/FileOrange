import { t } from "./i18n.ts";
/** A message fit to show a person, from whatever was thrown. */
export function messageOf(e: unknown): string {
  return t(e instanceof Error && e.message ? e.message : "Something went wrong.");
}
