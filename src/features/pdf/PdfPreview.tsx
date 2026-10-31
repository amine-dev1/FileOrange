import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { usePdf } from "../../app/PdfProvider";
import { useCapabilities } from "../../app/CapabilitiesProvider";
import { Button } from "../../components/Button";
import { messageOf } from "../../lib/tauri";
import type { PdfDocument } from "../../lib/types";
import type { PageImages } from "./pageImages";
import { turned } from "./plan";
import { AnnotationLayer } from "./annotations/AnnotationLayer";
import { RotatedPage } from "./RotatedPage";
import { pdfTaskState } from "./tasks";
import { displayWidth, requestWidth, stepZoom, percentOf, type Box } from "./zoom";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

interface Shown {
  page: number;
  width: number;
  url: string;
}

/** The large view of the current page. It scrolls when the page is bigger than the window. */
export function PdfPreview({ doc, images }: { doc: PdfDocument; images: PageImages }) {
  const { page, setPage, zoom, setZoom, plan } = usePdf();
  const { caps } = useCapabilities();
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box>({ w: 800, h: 600 });
  const [retry, setRetry] = useState(0);
  const [shown, setShown] = useState<Shown | null>(null);
  const [failure, setFailure] = useState<{ page: number; width: number; message: string } | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const entry = plan[page - 1];
  const source = doc.info.pages[entry.src - 1];
  const info = turned(source, entry.rot);
  const shownWidth = displayWidth(zoom, info, box);
  const maxWidth = caps?.limits.max_pdf_render_width ?? 4096;
  const canAnnotate = pdfTaskState(caps, "pdf_annotate").enabled;
  const want = useDebounced(requestWidth(shownWidth, window.devicePixelRatio || 1, maxWidth), 150);

  const src = entry.src;
  useEffect(() => {
    let cancelled = false;
    images
      .url(src, want)
      .then((url) => {
        if (cancelled) return;
        setShown({ page: src, width: want, url });
        setFailure(null);
      })
      .catch((e) => {
        if (!cancelled) setFailure({ page: src, width: want, message: messageOf(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [images, src, want, retry]);

  // A different page's picture is never shown in place of this one; the same page at another zoom is
  // kept (stretched) until the sharper render arrives.
  const url = shown && shown.page === src ? shown.url : null;
  // Stays up for the page until a render succeeds, whatever width was asked, so it doesn't flicker as the layout settles.
  const failed = failure && failure.page === src ? failure : null;
  const loading = !failed && !(shown && shown.page === src && shown.width === want);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    const percent = percentOf(shownWidth, info);
    const key = e.key;
    if (key === "PageDown") setPage(page + 1);
    else if (key === "PageUp") setPage(page - 1);
    else if (key === "Home") setPage(1);
    else if (key === "End") setPage(plan.length);
    else if ((e.ctrlKey || e.metaKey) && (key === "+" || key === "=")) setZoom(stepZoom(percent, 1));
    else if ((e.ctrlKey || e.metaKey) && key === "-") setZoom(stepZoom(percent, -1));
    else if ((e.ctrlKey || e.metaKey) && key === "0") setZoom({ mode: "fit-width" });
    else return;
    e.preventDefault();
  };

  return (
    <div className="pdf-preview" ref={boxRef} tabIndex={0} role="region" aria-label="Page preview" aria-busy={loading || undefined} onKeyDown={onKeyDown}>
      <div className="pdf-preview__page" style={{ width: shownWidth, aspectRatio: `${info.width_pt} / ${info.height_pt}` }}>
        {url ? <RotatedPage url={url} info={source} rot={entry.rot} alt={`Page ${page} of ${plan.length}`} /> : <div className="pdf-preview__skeleton" aria-hidden />}
        {url && <AnnotationLayer key={entry.src} srcPage={entry.src} info={source} rot={entry.rot} interactive={canAnnotate} />}
        {loading && url === null && (
          <span className="pdf-preview__busy" role="status">
            Drawing page {page}…
          </span>
        )}
      </div>
      {failed && (
        <div className="pdf-preview__error" role="alert">
          <p>
            <strong>Page {page} couldn't be drawn.</strong> {failed.message}
          </p>
          <Button size="sm" icon={<RefreshCw size={15} aria-hidden />} onClick={() => setRetry((n) => n + 1)}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}
