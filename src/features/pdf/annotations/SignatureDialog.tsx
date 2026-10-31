import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/Button";
import { Callout } from "../../../components/Callout";
import { Dialog } from "../../../components/Dialog";
import { PDF_WARNINGS } from "../tasks";
import { SIGNATURE_COLOR, type PendingSignature } from "./useAnnotations";

const W = 440;
const H = 170;

/** A pad to draw a signature with the mouse, pen or finger. The result is just ink on the page, never a digital signature. */
export function SignatureDialog({ onUse, onClose }: { onUse: (s: PendingSignature) => void; onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<[number, number][][]>([]);
  const [count, setCount] = useState(0);
  const drawing = useRef(false);

  const redraw = () => {
    const c = canvas.current;
    const g = c?.getContext("2d");
    if (!c || !g) return;
    g.clearRect(0, 0, W, H);
    g.strokeStyle = SIGNATURE_COLOR;
    g.fillStyle = SIGNATURE_COLOR;
    g.lineWidth = 2.4;
    g.lineCap = "round";
    g.lineJoin = "round";
    for (const s of strokes.current) {
      if (s.length === 1) {
        g.beginPath();
        g.arc(s[0][0], s[0][1], 1.2, 0, Math.PI * 2);
        g.fill();
      } else {
        g.beginPath();
        s.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.stroke();
      }
    }
  };

  useEffect(redraw, []);

  const at = (e: React.PointerEvent): [number, number] => {
    const r = canvas.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
  };

  const finish = () => {
    const all = strokes.current.flat();
    if (all.length === 0) return;
    const xs = all.map((p) => p[0]);
    const ys = all.map((p) => p[1]);
    const [l, t] = [Math.min(...xs), Math.min(...ys)];
    const w = Math.max(Math.max(...xs) - l, 4);
    const h = Math.max(Math.max(...ys) - t, 4);
    const aspect = Math.min(10, Math.max(0.2, w / h));
    onUse({ strokes: strokes.current.map((s) => s.map(([x, y]) => [(x - l) / w, (y - t) / h] as [number, number])), aspect });
  };

  return (
    <Dialog
      open
      title="Draw your signature"
      description="Draw with the mouse, a pen or your finger."
      onClose={onClose}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              strokes.current = [];
              setCount(0);
              redraw();
            }}
            disabled={count === 0}
          >
            Clear
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={finish} disabled={count === 0}>
            Use this signature
          </Button>
        </>
      }
    >
      <div className="card-stack">
        <canvas
          ref={canvas}
          width={W}
          height={H}
          className="sigpad"
          role="img"
          aria-label="Signature pad: draw here"
          data-testid="signature-pad"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            drawing.current = true;
            strokes.current.push([at(e)]);
            setCount(strokes.current.length);
            redraw();
          }}
          onPointerMove={(e) => {
            if (!drawing.current) return;
            strokes.current[strokes.current.length - 1].push(at(e));
            redraw();
          }}
          onPointerUp={() => (drawing.current = false)}
          onPointerCancel={() => (drawing.current = false)}
        />
        <Callout tone="warning">{PDF_WARNINGS.visualSignature}</Callout>
      </div>
    </Dialog>
  );
}
