import type { PdfPageInfo } from "../../lib/types";
import type { Zoom } from "../../state/EditorProvider";

export const ZOOM_STEPS = [25, 50, 75, 100, 125, 150, 200, 300, 400];
/** A PDF point is 1/72 inch; a CSS pixel is 1/96 inch. At 100% a page is shown at its printed size. */
const CSS_PX_PER_PT = 96 / 72;
const MARGIN = 48;
const MIN_PX = 60;
const MAX_PX = 16_000;

export interface Box {
  w: number;
  h: number;
}

/** How wide the page is shown on screen, in CSS pixels. */
export function displayWidth(zoom: Zoom, page: PdfPageInfo, box: Box): number {
  const availW = Math.max(120, box.w - MARGIN);
  const availH = Math.max(120, box.h - MARGIN);
  let w: number;
  switch (zoom.mode) {
    case "fit-width":
      w = availW;
      break;
    case "fit-page":
      w = Math.min(availW, (availH * page.width_pt) / page.height_pt);
      break;
    case "scale":
      w = page.width_pt * CSS_PX_PER_PT * (zoom.value / 100);
      break;
  }
  return Math.min(MAX_PX, Math.max(MIN_PX, w));
}

export const percentOf = (shownWidth: number, page: PdfPageInfo): number => Math.round((shownWidth / (page.width_pt * CSS_PX_PER_PT)) * 100);

/** The next zoom step above or below what's shown now. */
export function stepZoom(currentPercent: number, direction: 1 | -1): Zoom {
  const next = direction > 0 ? ZOOM_STEPS.find((s) => s > currentPercent + 0.5) : [...ZOOM_STEPS].reverse().find((s) => s < currentPercent - 0.5);
  const bound = direction > 0 ? ZOOM_STEPS[ZOOM_STEPS.length - 1] : ZOOM_STEPS[0];
  return { mode: "scale", value: next ?? bound };
}

/** Width to ask the engine for: sharp on this screen, rounded so nearby sizes share one render. */
export function requestWidth(shownWidth: number, devicePixelRatio: number, maxWidth: number): number {
  const wanted = Math.ceil((shownWidth * Math.max(1, devicePixelRatio)) / 64) * 64;
  return Math.max(64, Math.min(maxWidth, wanted));
}
