import { getLang, t } from "./i18n.ts";

/** In French: octets (o, Ko, Mo) and a decimal comma. */
const fr = () => getLang() === "fr";
const num = (s: string) => (fr() ? s.replace(".", ",") : s);

/** Decimal units, matching what Windows Explorer shows. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1000) return `${bytes} ${fr() ? "o" : "B"}`;
  const units = fr() ? ["Ko", "Mo", "Go", "To"] : ["KB", "MB", "GB", "TB"];
  let v = bytes / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${num(v >= 100 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1))} ${units[i]}`;
}

/** A limit the way the server words it ("100 MB" means 100 MiB), so the page and its error messages agree. */
export function formatLimit(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  if (mib >= 1024) return `${Math.round(mib / 1024)} ${fr() ? "Go" : "GB"}`;
  if (mib >= 1) return `${Math.round(mib)} ${fr() ? "Mo" : "MB"}`;
  return formatBytes(bytes);
}

export function formatJobDate(ts: number, now = new Date()): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days === 0) return t("Today, {time}", { time });
  if (days === 1) return t("Yesterday, {time}", { time });
  const date = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
  return `${date}, ${time}`;
}

export function greeting(now = new Date()): string {
  const h = now.getHours();
  if (h < 12) return t("Good morning");
  if (h < 18) return t("Good afternoon");
  return t("Good evening");
}

export function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

export { plural } from "./i18n.ts";

/** A PDF date string (`D:20240102120000+01'00'`) as a local date; the raw text if it can't be read. */
export function formatPdfDate(raw: string): string {
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(Z|[+-]\d{2}'?\d{2}'?)?/.exec(raw.trim());
  if (!m) return raw;
  const [, y, mo = "01", d = "01", h = "00", mi = "00", s = "00", tz] = m;
  let iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  if (tz === "Z") iso += "Z";
  else if (tz) iso += `${tz.slice(0, 3)}:${tz.replace(/'/g, "").slice(3, 5) || "00"}`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", ...(m[4] ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" as const } : {}) });
}
