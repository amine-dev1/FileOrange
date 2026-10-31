// Pure logic of the annotation editor. Run with: node --test tests/unit  (Node 22+ strips the TypeScript types itself.)
import test from "node:test";
import assert from "node:assert/strict";
import * as M from "../src/pages/editor/annotations/model.ts";

const measure = (s) => s.length * 6; // 6 pt per character, deterministic

test("bounds of each kind", () => {
  assert.deepEqual(M.bounds({ id: 1, kind: "highlight", page: 1, rects: [{ x: 10, y: 10, w: 20, h: 5 }, { x: 5, y: 20, w: 10, h: 5 }], color: "#FFEB3B" }), { x: 5, y: 10, w: 25, h: 15 });
  assert.deepEqual(M.bounds({ id: 1, kind: "image", page: 1, x: 1, y: 2, w: 3, h: 4, image: 0 }), { x: 1, y: 2, w: 3, h: 4 });
  const ink = M.bounds({ id: 1, kind: "ink", page: 1, strokes: [[[10, 10], [30, 20]]], color: "#000000", width: 2 });
  assert.deepEqual(ink, { x: 9, y: 9, w: 22, h: 12 });
  const line = M.bounds({ id: 1, kind: "shape", page: 1, shape: "line", x0: 30, y0: 40, x1: 10, y1: 20, color: "#000000", width: 2, fill: null });
  assert.deepEqual(line, { x: 9, y: 19, w: 22, h: 22 });
  assert.equal(M.bounds({ id: 1, kind: "text", page: 1, x: 0, y: 0, text: "a\nb", size: 10, color: "#000000", background: null, w: 100 }).h, 24);
});

test("move and scale keep geometry consistent", () => {
  const a = { id: 1, kind: "shape", page: 1, shape: "rect", x0: 10, y0: 10, x1: 50, y1: 30, color: "#000000", width: 2, fill: null };
  const moved = M.moveBy(a, 5, -5);
  assert.deepEqual([moved.x0, moved.y0, moved.x1, moved.y1], [15, 5, 55, 25]);
  const from = M.bounds(a);
  const doubled = M.scaleTo(a, from, { x: from.x, y: from.y, w: from.w * 2 - 2, h: from.h * 2 - 2 });
  // inner geometry (box minus the line width) is doubled
  assert.ok(Math.abs(doubled.x1 - doubled.x0 - 80) < 1e-6 && Math.abs(doubled.y1 - doubled.y0 - 40) < 1e-6, JSON.stringify(doubled));
  const img = { id: 2, kind: "image", page: 1, x: 0, y: 0, w: 10, h: 10, image: 0 };
  assert.deepEqual(M.scaleTo(img, M.bounds(img), { x: 5, y: 5, w: 20, h: 40 }), { ...img, x: 5, y: 5, w: 20, h: 40 });
  const ink = { id: 3, kind: "ink", page: 1, strokes: [[[0, 0], [10, 10]]], color: "#000000", width: 0 };
  const big = M.scaleTo(ink, M.bounds(ink), { x: 0, y: 0, w: 40, h: 20 });
  assert.deepEqual(big.strokes[0], [[0, 0], [40, 20]]);
});

test("hit testing: lines along their length, areas inside", () => {
  const line = { id: 1, kind: "shape", page: 1, shape: "line", x0: 0, y0: 0, x1: 100, y1: 0, color: "#000000", width: 2, fill: null };
  assert.ok(M.hits(line, 50, 3, 3));
  assert.ok(!M.hits(line, 50, 20, 3));
  const box = { id: 2, kind: "image", page: 1, x: 10, y: 10, w: 50, h: 50, image: 0 };
  assert.ok(M.hits(box, 30, 30, 0) && !M.hits(box, 80, 80, 2));
  assert.equal(M.topmostAt([box, { ...box, id: 3 }], 1, 30, 30, 0).id, 3, "later annotations are on top");
  assert.equal(M.topmostAt([box], 2, 30, 30, 0), null, "other pages are ignored");
});

test("wrapText keeps breaks, wraps at words and cuts long words", () => {
  assert.equal(M.wrapText("hello world again", 60, measure), "hello\nworld\nagain"); // 10 chars = 60pt: "hello world" is 66
  assert.equal(M.wrapText("one\n\ntwo", 600, measure), "one\n\ntwo");
  const cut = M.wrapText("abcdefghijklmnop", 30, measure);
  assert.ok(cut.split("\n").every((l) => l.length <= 5), cut);
  assert.equal(cut.replace(/\n/g, ""), "abcdefghijklmnop");
  assert.equal(M.wrapText("", 100, measure), "");
});

test("drawable mirrors what the built-in font can show", () => {
  assert.ok(M.drawable("Héllo, café — “quoted” € 5\n\ttab"));
  assert.ok(!M.drawable("مرحبا"));
  assert.ok(!M.drawable("日本語"));
  assert.ok(!M.drawable("emoji 😀"));
});

test("toWire filters pages, strips editor fields, wraps text and numbers pictures", () => {
  const list = [
    { id: 1, kind: "text", page: 1, x: 10, y: 10, text: "hello world again", size: 10, color: "#000000", background: null, w: 68 },
    { id: 2, kind: "text", page: 1, x: 0, y: 0, text: "   ", size: 10, color: "#000000", background: null, w: 50 },
    { id: 3, kind: "image", page: 2, x: 0, y: 0, w: 10, h: 10, image: 7 },
    { id: 4, kind: "image", page: 3, x: 0, y: 0, w: 10, h: 10, image: 9 },
    { id: 5, kind: "ink", page: 1, strokes: [[[0, 0]]], color: "#000000", width: 1, signature: true },
    { id: 6, kind: "text", page: 1, x: 0, y: 0, text: "note", size: 10, color: "#000000", background: "#FFF2A8", w: 80 },
  ];
  const keep = new Set([1, 2]);
  assert.deepEqual(M.usedPictures(list, keep), [7]);
  const wire = M.toWire(list, keep, new Map([[7, 0]]), measure);
  assert.equal(wire.length, 4);
  assert.ok(wire.every((a) => !("id" in a) && !("signature" in a)));
  assert.ok(wire[0].text.includes("\n"), "wrapped");
  assert.equal(wire[0].h, null);
  assert.equal(wire[1].image, 0);
  assert.equal(wire[3].background, "#FFF2A8");
  assert.ok(wire[3].h > 0, "a note has a box height");
});

test("history: undo, redo and new edits clear the redo branch", () => {
  let h = M.fresh([]);
  h = M.commit(h, ["a"]);
  h = M.commit(h, ["a", "b"]);
  assert.deepEqual(h.present, ["a", "b"]);
  h = M.undo(h);
  assert.deepEqual(h.present, ["a"]);
  h = M.redo(h);
  assert.deepEqual(h.present, ["a", "b"]);
  h = M.undo(M.undo(h));
  assert.deepEqual(h.present, []);
  assert.equal(M.undo(h), h, "nothing to undo");
  h = M.commit(h, ["c"]);
  assert.equal(M.redo(h), h, "a new edit drops the redo branch");
  // replace (mid-drag) changes the state without an undo step
  const r = M.replace(h, ["c2"]);
  assert.deepEqual(M.undo(r).present, []);
});

test("thin keeps ends, arrowHead matches the backend", () => {
  const pts = [[0, 0], [0.1, 0], [0.2, 0], [5, 0], [5.1, 0], [10, 0]];
  const t = M.thin(pts);
  assert.deepEqual(t[0], [0, 0]);
  assert.deepEqual(t[t.length - 1], [10, 0]);
  assert.ok(t.length < pts.length);
  assert.equal(M.arrowHead(0, 0, 0, 0, 2), null);
  const [a, b] = M.arrowHead(0, 0, 100, 0, 2);
  // head length is max(4 x width, 9) = 9 points; the wings sit at +-0.5 rad behind the tip
  assert.ok(Math.abs(a[0] - (100 - 9 * Math.cos(0.5))) < 1e-9 && Math.abs(a[1] + 9 * Math.sin(0.5)) < 1e-9, JSON.stringify(a));
  assert.ok(Math.abs(b[0] - a[0]) < 1e-9 && Math.abs(b[1] + a[1]) < 1e-9, JSON.stringify(b));
});
