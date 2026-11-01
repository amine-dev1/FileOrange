// What goes inside a QR code, and what a scanned one means. Pure functions, no browser APIs (unit tested in tests/qr.test.mjs).

export type QrKind = "url" | "text" | "wifi" | "contact" | "email" | "phone" | "sms";

export interface WifiData {
  ssid: string;
  password: string;
  security: "WPA" | "WEP" | "nopass";
  hidden: boolean;
}

export interface ContactData {
  first: string;
  last: string;
  phone: string;
  email: string;
  org: string;
  title: string;
  website: string;
  address: string;
}

export interface QrForm {
  url: string;
  text: string;
  wifi: WifiData;
  contact: ContactData;
  email: { to: string; subject: string; body: string };
  phone: string;
  sms: { number: string; message: string };
}

export const EMPTY_FORM: QrForm = {
  url: "",
  text: "",
  wifi: { ssid: "", password: "", security: "WPA", hidden: false },
  contact: { first: "", last: "", phone: "", email: "", org: "", title: "", website: "", address: "" },
  email: { to: "", subject: "", body: "" },
  phone: "",
  sms: { number: "", message: "" },
};

/** The text to encode, or a reason it can't be made yet (`null` text). */
export interface Payload {
  text: string | null;
  problem?: string;
}

/** Wi-Fi fields escape \ ; , : and " with a backslash. */
export const escapeWifi = (s: string) => s.replace(/([\\;,:"])/g, "\\$1");
/** vCard values escape \ , ; and turn line breaks into \n. */
const escapeVcard = (s: string) => s.replace(/([\\,;])/g, "\\$1").replace(/\r?\n/g, "\\n");
// "+33 (0)6…" is a common way to write a number; the (0) is dropped when dialling from abroad.
const cleanPhone = (s: string) => s.replace(/\(0\)/g, "").replace(/[^\d+*#]/g, "");

export function normalizeUrl(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  // Something with a scheme is kept as typed; a bare address gets https://.
  return /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
}

export function buildPayload(kind: QrKind, f: QrForm): Payload {
  switch (kind) {
    case "url": {
      const u = normalizeUrl(f.url);
      if (!u) return { text: null };
      if (/\s/.test(u)) return { text: null, problem: "A web address can't contain spaces." };
      return { text: u };
    }
    case "text":
      return { text: f.text.length ? f.text : null };
    case "wifi": {
      const w = f.wifi;
      if (!w.ssid.trim()) return { text: null };
      if (w.security !== "nopass" && !w.password) return { text: null, problem: "Enter the Wi-Fi password, or choose “No password”." };
      if (w.security === "WPA" && w.password.length > 0 && (w.password.length < 8 || w.password.length > 63)) {
        return { text: null, problem: "A WPA password has 8 to 63 characters." };
      }
      const pw = w.security === "nopass" ? "" : `P:${escapeWifi(w.password)};`;
      return { text: `WIFI:T:${w.security};S:${escapeWifi(w.ssid)};${pw}${w.hidden ? "H:true;" : ""};` };
    }
    case "contact": {
      const c = f.contact;
      const name = [c.first.trim(), c.last.trim()].filter(Boolean).join(" ");
      if (!name && !c.org.trim() && !c.phone.trim() && !c.email.trim()) return { text: null };
      const lines = ["BEGIN:VCARD", "VERSION:3.0", `N:${escapeVcard(c.last.trim())};${escapeVcard(c.first.trim())};;;`, `FN:${escapeVcard(name || c.org.trim() || c.phone.trim() || c.email.trim())}`];
      if (c.org.trim()) lines.push(`ORG:${escapeVcard(c.org.trim())}`);
      if (c.title.trim()) lines.push(`TITLE:${escapeVcard(c.title.trim())}`);
      if (c.phone.trim()) lines.push(`TEL;TYPE=CELL:${cleanPhone(c.phone)}`);
      if (c.email.trim()) lines.push(`EMAIL:${escapeVcard(c.email.trim())}`);
      if (c.website.trim()) lines.push(`URL:${escapeVcard(normalizeUrl(c.website))}`);
      if (c.address.trim()) lines.push(`ADR:;;${escapeVcard(c.address.trim())};;;;`);
      lines.push("END:VCARD");
      return { text: lines.join("\r\n") };
    }
    case "email": {
      const e = f.email;
      const to = e.to.trim();
      if (!to) return { text: null };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { text: null, problem: "Check the email address." };
      const q = [e.subject && `subject=${encodeURIComponent(e.subject)}`, e.body && `body=${encodeURIComponent(e.body)}`].filter(Boolean).join("&");
      return { text: `mailto:${to}${q ? `?${q}` : ""}` };
    }
    case "phone": {
      const n = cleanPhone(f.phone);
      if (!n) return { text: null };
      return { text: `tel:${n}` };
    }
    case "sms": {
      const n = cleanPhone(f.sms.number);
      if (!n) return { text: null };
      return { text: `SMSTO:${n}:${f.sms.message}` };
    }
  }
}

// ---------------------------------------------------------------- reading

export type Scanned =
  | { kind: "url"; url: string; host: string; safe: boolean }
  | { kind: "wifi"; ssid: string; password: string; security: string; hidden: boolean }
  | { kind: "contact"; fields: { label: string; value: string }[] }
  | { kind: "email"; to: string; subject: string; body: string }
  | { kind: "phone"; number: string }
  | { kind: "sms"; number: string; message: string }
  | { kind: "geo"; lat: number; lon: number }
  | { kind: "text" };

/** Split on `sep` where it isn't escaped with a backslash, and remove the escapes. */
function splitEscaped(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length) {
      cur += s[++i];
    } else if (ch === sep) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseWifi(s: string): Scanned | null {
  if (!/^WIFI:/i.test(s)) return null;
  const fields: Record<string, string> = {};
  for (const part of splitEscaped(s.slice(5), ";")) {
    const i = part.indexOf(":");
    if (i > 0) fields[part.slice(0, i).toUpperCase()] = part.slice(i + 1);
  }
  if (fields.S === undefined) return null;
  const t = (fields.T ?? "").toUpperCase();
  return { kind: "wifi", ssid: fields.S, password: fields.P ?? "", security: t === "" || t === "NOPASS" ? "nopass" : t, hidden: (fields.H ?? "").toLowerCase() === "true" };
}

const unescapeVcard = (s: string) => s.replace(/\\n/gi, "\n").replace(/\\([\\,;:])/g, "$1");

function parseVcard(s: string): Scanned | null {
  if (!/^BEGIN:VCARD/i.test(s)) return null;
  // Unfold continuation lines (a line break followed by a space).
  const lines = s.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const fields: { label: string; value: string }[] = [];
  let fn = "";
  let n = "";
  for (const line of lines) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).split(";")[0].toUpperCase().replace(/^ITEM\d+\./, "");
    const value = line.slice(i + 1);
    if (key === "FN") fn = unescapeVcard(value);
    else if (key === "N") {
      const [last = "", first = ""] = value.split(";").map(unescapeVcard);
      n = [first, last].filter(Boolean).join(" ");
    } else if (key === "ORG") fields.push({ label: "Organisation", value: unescapeVcard(value.split(";").filter(Boolean).join(", ")) });
    else if (key === "TITLE") fields.push({ label: "Job title", value: unescapeVcard(value) });
    else if (key === "TEL") fields.push({ label: "Phone", value: unescapeVcard(value) });
    else if (key === "EMAIL") fields.push({ label: "Email", value: unescapeVcard(value) });
    else if (key === "URL") fields.push({ label: "Website", value: unescapeVcard(value) });
    else if (key === "ADR") fields.push({ label: "Address", value: value.split(";").map(unescapeVcard).filter(Boolean).join(", ") });
    else if (key === "NOTE") fields.push({ label: "Note", value: unescapeVcard(value) });
  }
  const name = fn || n;
  if (name) fields.unshift({ label: "Name", value: name });
  return { kind: "contact", fields };
}

function parseMecard(s: string): Scanned | null {
  if (!/^MECARD:/i.test(s)) return null;
  const fields: { label: string; value: string }[] = [];
  const labels: Record<string, string> = { N: "Name", TEL: "Phone", EMAIL: "Email", URL: "Website", ADR: "Address", NOTE: "Note", ORG: "Organisation" };
  for (const part of splitEscaped(s.slice(7), ";")) {
    const i = part.indexOf(":");
    if (i <= 0) continue;
    const key = part.slice(0, i).toUpperCase();
    let value = part.slice(i + 1);
    if (key === "N") value = value.split(",").reverse().join(" ").trim();
    if (labels[key] && value) fields.push({ label: labels[key], value });
  }
  return { kind: "contact", fields };
}

/** Percent-decoding. `form` also turns + into a space, as some generators do in mailto: and sms: messages (never in numbers). */
function decode(s: string, form = false): string {
  try {
    return decodeURIComponent(form ? s.replace(/\+/g, "%20") : s);
  } catch {
    return s;
  }
}

export function parseScanned(raw: string): Scanned {
  const s = raw.trim();
  const wifi = parseWifi(s);
  if (wifi) return wifi;
  const card = parseVcard(s) ?? parseMecard(s);
  if (card) return card;
  let m = /^mailto:([^?]*)(?:\?(.*))?$/is.exec(s);
  if (m) {
    const params = new Map<string, string>();
    for (const kv of (m[2] ?? "").split("&")) {
      const [k, v = ""] = kv.split("=");
      if (k) params.set(k.toLowerCase(), decode(v, true));
    }
    return { kind: "email", to: decode(m[1]), subject: params.get("subject") ?? "", body: params.get("body") ?? "" };
  }
  m = /^MATMSG:(.*)$/is.exec(s);
  if (m) {
    const f: Record<string, string> = {};
    for (const part of splitEscaped(m[1], ";")) {
      const i = part.indexOf(":");
      if (i > 0) f[part.slice(0, i).toUpperCase()] = part.slice(i + 1);
    }
    return { kind: "email", to: f.TO ?? "", subject: f.SUB ?? "", body: f.BODY ?? "" };
  }
  m = /^tel:(.+)$/i.exec(s);
  if (m) return { kind: "phone", number: decode(m[1]) };
  m = /^SMSTO:([^:]*):?(.*)$/is.exec(s);
  if (m) return { kind: "sms", number: m[1], message: m[2] };
  m = /^sms:([^?]*)(?:\?body=(.*))?$/is.exec(s);
  if (m) return { kind: "sms", number: decode(m[1]), message: decode(m[2] ?? "", true) };
  m = /^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i.exec(s);
  if (m) {
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { kind: "geo", lat, lon };
  }
  if (/^https?:\/\/\S+$/i.test(s)) {
    try {
      const u = new URL(s);
      return { kind: "url", url: u.href, host: u.hostname, safe: true };
    } catch {
      /* not a real address */
    }
  }
  // Bare "www.example.com" is a link too.
  if (/^www\.[^\s/]+\.[a-z]{2,}(\/\S*)?$/i.test(s)) {
    try {
      const u = new URL(`https://${s}`);
      return { kind: "url", url: u.href, host: u.hostname, safe: true };
    } catch {
      /* not a real address */
    }
  }
  return { kind: "text" };
}

// ---------------------------------------------------------------- colours

function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** WCAG contrast ratio between two #rrggbb colours (1 to 21). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Many scanners only read dark codes on a light background. */
export const isInverted = (fg: string, bg: string) => luminance(fg) > luminance(bg);

/** A file name for the code, from what it contains. */
export function fileNameFor(kind: QrKind, f: QrForm): string {
  const base =
    kind === "url"
      ? (() => {
          try {
            return new URL(normalizeUrl(f.url)).hostname.replace(/^www\./, "");
          } catch {
            return "";
          }
        })()
      : kind === "wifi"
        ? `wifi-${f.wifi.ssid}`
        : kind === "contact"
          ? [f.contact.first, f.contact.last].filter(Boolean).join(" ") || f.contact.org
          : kind;
  const clean = Array.from(base)
    .filter((ch) => ch.charCodeAt(0) >= 32 && !'\\/:*?"<>|'.includes(ch))
    .join("")
    .trim()
    .slice(0, 60);
  return `qr-${clean || kind}`;
}
