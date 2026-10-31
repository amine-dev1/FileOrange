import type { PdfPageInfo } from "../../lib/types";
import type { Rotation } from "./plan";

/**
 * A page picture turned by `rot`. The engine draws the page as it is in the file; turning is applied
 * here so that rotating is instant and the saved copy (which the engine writes) matches what is shown.
 */
export function RotatedPage({ url, info, rot, alt, className }: { url: string; info: PdfPageInfo; rot: Rotation; alt: string; className?: string }) {
  if (rot === 0) return <img className={className} src={url} alt={alt} draggable={false} style={{ width: "100%", height: "100%", display: "block" }} />;
  const sideways = rot % 180 !== 0;
  // The frame has the turned shape. A sideways image is as wide as the frame is tall, centred, then turned.
  return (
    <img
      className={className}
      src={url}
      alt={alt}
      draggable={false}
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        width: sideways ? `${(info.width_pt / info.height_pt) * 100}%` : "100%",
        height: "auto",
        transform: `translate(-50%, -50%) rotate(${rot}deg)`,
      }}
    />
  );
}
