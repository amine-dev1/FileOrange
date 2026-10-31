import type { PdfPageInfo } from "../../lib/types";
import type { Rotation } from "./plan";

/**
 * A page picture turned by `rot`. The engine draws the page as it is in the file; turning is applied here so rotating is
 * instant, and the saved copy (which the engine writes) matches what is shown.
 */
export function RotatedPage({ url, info, rot, alt }: { url: string; info: PdfPageInfo; rot: Rotation; alt: string }) {
  if (rot === 0) return <img src={url} alt={alt} draggable={false} className="block size-full select-none" />;
  const sideways = rot % 180 !== 0;
  // The frame has the turned shape. A sideways image is as wide as the frame is tall, centred, then turned.
  return (
    <img
      src={url}
      alt={alt}
      draggable={false}
      className="absolute left-1/2 top-1/2 h-auto select-none"
      style={{ width: sideways ? `${(info.width_pt / info.height_pt) * 100}%` : "100%", transform: `translate(-50%, -50%) rotate(${rot}deg)` }}
    />
  );
}
