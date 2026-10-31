import { t } from "./i18n.ts";
/** "holiday.png", or "holiday.png +3 more". */
export const titleFor = (items: { name: string }[], fallback = "files") => (items.length === 0 ? fallback : items.length === 1 ? items[0].name : t("{name} +{count} more", { name: items[0].name, count: items.length - 1 }));

/** A name the user typed for an output, with the extension added if it is missing, or the fallback. */
export function withExtension(name: string, ext: string, fallback: string) {
  const n = name.trim() || fallback;
  return n.toLowerCase().endsWith(`.${ext}`) ? n : `${n}.${ext}`;
}
