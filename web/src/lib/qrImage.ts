// Drawing QR codes (SVG and PNG) and finding them in pictures. Everything runs in the browser: nothing is uploaded.
import QRCode from "qrcode";
import jsQR from "jsqr";

export type Ecc = "L" | "M" | "Q" | "H";

export interface Matrix {
  size: number;
  dark: (row: number, col: number) => boolean;
}

export interface Look {
  fg: string;
  bg: string;
  /** Quiet zone around the code, in modules. Scanners want 4; 2 usually works. */
  margin: number;
  /** A picture in the middle (a data: URL), and its natural size. */
  logo?: { src: string; width: number; height: number } | null;
}

/** Share of the code's width the logo may cover. With high error correction, up to ~30% of the code can be hidden. */
export const LOGO_SHARE = 0.22;

export class TooMuchData extends Error {}

export function makeMatrix(text: string, ecc: Ecc): Matrix {
  try {
    const qr = QRCode.create(text, { errorCorrectionLevel: ecc });
    const { size, data } = qr.modules;
    return { size, dark: (r, c) => data[r * size + c] === 1 };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/too big|amount of data/i.test(msg)) throw new TooMuchData(msg);
    throw e;
  }
}

/** Where the logo goes, in module units including the margin: a centred square, with a little room around it. */
function logoBox(m: Matrix, look: Look) {
  if (!look.logo) return null;
  const side = m.size * LOGO_SHARE;
  const ratio = look.logo.width / look.logo.height || 1;
  const w = ratio >= 1 ? side : side * ratio;
  const h = ratio >= 1 ? side / ratio : side;
  const total = m.size + look.margin * 2;
  const pad = 0.6;
  return { x: (total - w) / 2, y: (total - h) / 2, w, h, pad };
}

function hidden(box: ReturnType<typeof logoBox>, x: number, y: number) {
  if (!box) return false;
  return x + 1 > box.x - box.pad && x < box.x + box.w + box.pad && y + 1 > box.y - box.pad && y < box.y + box.h + box.pad;
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One path, one rectangle per run of dark modules in a row: small files that scale to any size. */
export function toSvg(m: Matrix, look: Look): string {
  const total = m.size + look.margin * 2;
  const box = logoBox(m, look);
  let d = "";
  for (let r = 0; r < m.size; r++) {
    let c = 0;
    while (c < m.size) {
      const y = r + look.margin;
      if (m.dark(r, c) && !hidden(box, c + look.margin, y)) {
        const start = c;
        while (c < m.size && m.dark(r, c) && !hidden(box, c + look.margin, y)) c++;
        d += `M${start + look.margin} ${y}h${c - start}v1h-${c - start}z`;
      } else c++;
    }
  }
  const logo = box && look.logo ? `<image x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" href="${xmlEscape(look.logo.src)}" preserveAspectRatio="xMidYMid meet"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="${xmlEscape(look.bg)}"/><path fill="${xmlEscape(look.fg)}" d="${d}"/>${logo}</svg>`;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("The picture couldn't be read."));
    img.src = src;
  });
}

/** Draw the code on a canvas `px` pixels wide. Module edges are rounded to whole pixels so there are no hairline gaps. */
export async function toCanvas(m: Matrix, look: Look, px: number): Promise<HTMLCanvasElement> {
  const total = m.size + look.margin * 2;
  const cell = px / total;
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser can't draw pictures.");
  ctx.fillStyle = look.bg;
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = look.fg;
  const box = logoBox(m, look);
  const at = (v: number) => Math.round(v * cell);
  for (let r = 0; r < m.size; r++) {
    for (let c = 0; c < m.size; c++) {
      const x = c + look.margin;
      const y = r + look.margin;
      if (m.dark(r, c) && !hidden(box, x, y)) ctx.fillRect(at(x), at(y), at(x + 1) - at(x), at(y + 1) - at(y));
    }
  }
  if (box && look.logo) {
    const img = await loadImage(look.logo.src);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, box.x * cell, box.y * cell, box.w * cell, box.h * cell);
  }
  return canvas;
}

export function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The picture couldn't be made."))), "image/png"));
}

// ---------------------------------------------------------------- reading

export interface Found {
  text: string;
  /** Corners of the code in the picture's own pixels: top-left, top-right, bottom-right, bottom-left. */
  corners: { x: number; y: number }[];
}

function decodeCanvas(source: CanvasImageSource, w: number, h: number, scale: number, invert: "attemptBoth" | "dontInvert" = "attemptBoth"): Found | null {
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  // Transparent pixels count as white: a code saved with no background is still readable.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(source, 0, 0, cw, ch);
  const data = ctx.getImageData(0, 0, cw, ch);
  const hit = jsQR(data.data, cw, ch, { inversionAttempts: invert });
  if (!hit) return null;
  const l = hit.location;
  return { text: hit.data, corners: [l.topLeftCorner, l.topRightCorner, l.bottomRightCorner, l.bottomLeftCorner].map((p) => ({ x: p.x / scale, y: p.y / scale })) };
}

/** Try a few sizes: scanners work best when the code is a few hundred pixels across, and huge photos are slow. */
export function findInImage(source: CanvasImageSource, w: number, h: number): Found | null {
  const longest = Math.max(w, h);
  const targets = [1200, 2400, 700, 400];
  const tried = new Set<number>();
  for (const t of targets) {
    const scale = Math.min(1, t / longest);
    const key = Math.round(scale * 1000);
    if (tried.has(key)) continue;
    tried.add(key);
    const hit = decodeCanvas(source, w, h, scale);
    if (hit) return hit;
  }
  return null;
}

/** One frame from the camera, scaled down for speed. */
export function findInVideo(video: HTMLVideoElement): Found | null {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  return decodeCanvas(video, w, h, Math.min(1, 720 / Math.max(w, h)));
}

export interface Opened {
  url: string;
  width: number;
  height: number;
  found: Found | null;
}

/** Open a picture the user chose and look for a QR code in it. The caller revokes `url` when done. */
export async function scanFile(file: Blob): Promise<Opened> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) throw new Error("The picture couldn't be read.");
    return { url, width: w, height: h, found: findInImage(img, w, h) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

/** Read the code back from the drawn picture, the way a phone would: catches colours or logos that break it. */
export async function selfCheck(m: Matrix, look: Look, expected: string): Promise<boolean> {
  const canvas = await toCanvas(m, look, Math.max(240, (m.size + look.margin * 2) * 4));
  // No colour inversion here: many phone cameras don't try it either.
  const hit = decodeCanvas(canvas, canvas.width, canvas.height, 1, "dontInvert");
  return hit?.text === expected;
}
