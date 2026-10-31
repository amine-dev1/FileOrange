// Pure logic that the pages rely on. Run with: npm run test:unit  (Node 22+ strips the TypeScript types itself.)
import test from "node:test";
import assert from "node:assert/strict";
import * as plan from "../src/pages/editor/plan.ts";
import * as zoom from "../src/pages/editor/zoom.ts";
import { withExtension, titleFor } from "../src/lib/names.ts";
import { formatBytes, plural, extensionOf, formatPdfDate } from "../src/lib/format.ts";

test("page plan: rotate, delete, move", () => {
  let p = plan.identity(4);
  assert.ok(plan.isIdentity(p, 4));
  p = plan.rotate(p, new Set([2]), 90);
  assert.equal(p[1].rot, 90);
  p = plan.rotate(p, new Set([2]), -90);
  p = plan.rotate(p, new Set([2]), -90);
  assert.equal(p[1].rot, 270);
  const moved = plan.moveBy(plan.identity(4), new Set([3]), -1);
  assert.deepEqual(moved.map((x) => x.src), [1, 3, 2, 4]);
  const block = plan.moveBlock(plan.identity(5), new Set([1, 2]), 5);
  assert.deepEqual(block.map((x) => x.src), [3, 4, 5, 1, 2]);
  assert.equal(plan.remove(plan.identity(1), new Set([1])).length, 1, "the last page can't be deleted");
  assert.deepEqual(plan.toJobPages(plan.rotate(plan.identity(2), new Set([1]), 180)), [{ page: 1, rotate: 180 }, { page: 2, rotate: 0 }]);
});

test("zoom steps and render width", () => {
  assert.deepEqual(zoom.stepZoom(100, 1), { mode: "scale", value: 125 });
  assert.deepEqual(zoom.stepZoom(100, -1), { mode: "scale", value: 75 });
  assert.deepEqual(zoom.stepZoom(400, 1), { mode: "scale", value: 400 });
  assert.equal(zoom.requestWidth(500, 2, 4096) % 64, 0);
  assert.ok(zoom.requestWidth(5000, 2, 4096) <= 4096);
  const page = { width_pt: 600, height_pt: 800 };
  assert.equal(Math.round(zoom.displayWidth({ mode: "fit-width" }, page, { w: 648, h: 500 })), 600);
  assert.ok(zoom.displayWidth({ mode: "fit-page" }, page, { w: 2000, h: 548 }) < 600);
});

test("names and sizes", () => {
  assert.equal(withExtension("", "pdf", "merged"), "merged.pdf");
  assert.equal(withExtension("Report.PDF", "pdf", "x"), "Report.PDF");
  assert.equal(withExtension("a", "zip", "x"), "a.zip");
  assert.equal(titleFor([{ name: "a.png" }]), "a.png");
  assert.equal(titleFor([{ name: "a.png" }, { name: "b.png" }, { name: "c.png" }]), "a.png +2 more");
  assert.equal(formatBytes(1500), "1.5 KB");
  assert.equal(formatBytes(12_000_000), "12 MB");
  assert.equal(plural(1, "file"), "1 file");
  assert.equal(plural(2, "file"), "2 files");
  assert.equal(extensionOf("a.b.JPG"), "jpg");
  assert.equal(extensionOf(".hidden"), "");
  assert.match(formatPdfDate("D:20240102120000Z"), /2024/);
});

import { whiteToTransparent, contentBox, fitFontSize } from "../src/pages/editor/annotations/signatureImage.ts";

test("signature photos: paper becomes transparent, ink stays, edges fade", () => {
  // white, black, mid grey, light grey
  const px = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 183, 183, 183, 255, 230, 230, 230, 255]);
  const kept = whiteToTransparent(px);
  assert.equal(px[3], 0, "white paper is gone");
  assert.equal(px[7], 255, "black ink is kept");
  assert.ok(px[11] > 0 && px[11] < 255, `the edge fades (${px[11]})`);
  assert.equal(px[15], 0, "light grey paper texture is gone too");
  assert.equal(kept, 2);
});

test("signature crop: the box around what shows, with padding, or null", () => {
  const w = 10, h = 6;
  const px = new Uint8ClampedArray(w * h * 4);
  const dot = (x, y) => (px[(y * w + x) * 4 + 3] = 255);
  dot(3, 2);
  dot(6, 4);
  assert.deepEqual(contentBox(px, w, h, 1), { x: 2, y: 1, w: 6, h: 5 });
  assert.deepEqual(contentBox(px, w, h, 10), { x: 0, y: 0, w: 10, h: 6 }, "padding stops at the edges");
  assert.equal(contentBox(new Uint8ClampedArray(w * h * 4), w, h), null);
});

test("typed signature: the font size fills the room without going past the limits", () => {
  assert.equal(fitFontSize(200, 100, 400), 120, "short names stop at the largest size");
  assert.equal(fitFontSize(1000, 100, 400), 40);
  assert.equal(fitFontSize(100000, 100, 400), 18, "very long names stop at the smallest size");
});
