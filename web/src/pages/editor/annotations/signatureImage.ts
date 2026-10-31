/** Pixel work for signatures made from a photo or from typed text. Pure functions over RGBA bytes, so they can be tested. */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Paper to transparency: near-white pixels become see-through, ink stays, and the edge in between fades, so strokes keep smooth
 * edges. Works in place on RGBA bytes. Returns how many pixels still show.
 */
export function whiteToTransparent(rgba: Uint8ClampedArray, light = 215, dark = 150): number {
  let kept = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const lum = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    const a = lum >= light ? 0 : lum <= dark ? 1 : (light - lum) / (light - dark);
    rgba[i + 3] = Math.round(rgba[i + 3] * a);
    if (rgba[i + 3] > 0) kept++;
  }
  return kept;
}

/** The smallest box around everything that isn't (almost) transparent, with some room around it; null when nothing shows. */
export function contentBox(rgba: Uint8ClampedArray, width: number, height: number, pad = 4, minAlpha = 16): Box | null {
  let [l, t, r, b] = [width, height, -1, -1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] >= minAlpha) {
        if (x < l) l = x;
        if (x > r) r = x;
        if (y < t) t = y;
        if (y > b) b = y;
      }
    }
  }
  if (r < 0) return null;
  const x = Math.max(0, l - pad);
  const y = Math.max(0, t - pad);
  return { x, y, w: Math.min(width, r + pad + 1) - x, h: Math.min(height, b + pad + 1) - y };
}

/** Font size that makes `textWidth` (measured at `measuredAt` px) fill `room` px, within limits. */
export function fitFontSize(textWidth: number, measuredAt: number, room: number, max = 120, min = 18): number {
  if (textWidth <= 0) return max;
  return Math.max(min, Math.min(max, Math.floor((measuredAt * room) / textWidth)));
}
