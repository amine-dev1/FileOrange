/** Decimal units, matching what Windows Explorer shows. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= 100 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatJobDate(ts: number, now = new Date()): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  const date = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
  return `${date}, ${time}`;
}

export function greeting(now = new Date()): string {
  const h = now.getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** Parent folder of a Windows or POSIX path (no trailing separator). */
export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (i < 0) return path;
  if (i === 0) return path.slice(0, 1);
  if (i === 2 && path[1] === ":") return path.slice(0, 3); // C:\
  return path.slice(0, i);
}

export function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i < 0 ? path : path.slice(i + 1);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

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
