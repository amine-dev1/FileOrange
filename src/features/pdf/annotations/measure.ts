/** Width of `text` drawn at `size` points in the font the saved copy uses (Helvetica; Arial has the same widths). */
let ctx: CanvasRenderingContext2D | null | undefined;

export function measureText(text: string, size: number): number {
  if (ctx === undefined) {
    try {
      ctx = document.createElement("canvas").getContext("2d");
    } catch {
      ctx = null;
    }
  }
  if (!ctx) return text.length * size * 0.52;
  ctx.font = `${size}px Helvetica, Arial, "Liberation Sans", sans-serif`;
  return ctx.measureText(text).width;
}

export const FONT_FAMILY = 'Helvetica, Arial, "Liberation Sans", sans-serif';
