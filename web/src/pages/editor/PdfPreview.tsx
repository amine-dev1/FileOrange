import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { operationState } from "../../lib/capabilities";
import { messageOf } from "../../lib/errors";
import type { PdfDocumentResponse } from "../../lib/types";
import { useCapabilities } from "../../state/CapabilitiesProvider";
import { useEditor } from "../../state/EditorProvider";
import { Button } from "../../components/ui";
import { AnnotationLayer } from "./annotations/AnnotationLayer";
import type { PageImages } from "./pageImages";
import { turned } from "./plan";
import { RotatedPage } from "./RotatedPage";
import { displayWidth, percentOf, requestWidth, stepZoom, type Box } from "./zoom";

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
export function PdfPreview({ doc, images }: { doc: PdfDocumentResponse; images: PageImages }) {
  const { page, setPage, zoom, setZoom, plan } = useEditor();
  const { caps } = useCapabilities();
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box>({ w: 800, h: 600 });
  const [retry, setRetry] = useState(0);
  const [shown, setShown] = useState<Shown | null>(null);
  const [failure, setFailure] = useState<{ page: number; message: string } | null>(null);

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
  const want = useDebounced(requestWidth(shownWidth, window.devicePixelRatio || 1, maxWidth), 150);
  const canAnnotate = caps ? operationState(caps, "pdf_annotate").state === "ready" : false;

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
      .catch((e) => !cancelled && setFailure({ page: src, message: messageOf(e) }));
    return () => {
      cancelled = true;
    };
  }, [images, src, want, retry]);

  // A different page's picture is never shown in place of this one; the same page at another zoom is kept (stretched)
  // until the sharper render arrives.
  const url = shown && shown.page === src ? shown.url : null;
  const failed = failure && failure.page === src ? failure : null;
  const loading = !failed && !(shown && shown.page === src && shown.width === want);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    const percent = percentOf(shownWidth, info);
    const k = e.key;
    if (k === "PageDown") setPage(page + 1);
    else if (k === "PageUp") setPage(page - 1);
    else if (k === "Home") setPage(1);
    else if (k === "End") setPage(plan.length);
    else if ((e.ctrlKey || e.metaKey) && (k === "+" || k === "=")) setZoom(stepZoom(percent, 1));
    else if ((e.ctrlKey || e.metaKey) && k === "-") setZoom(stepZoom(percent, -1));
    else if ((e.ctrlKey || e.metaKey) && k === "0") setZoom({ mode: "fit-width" });
    else return;
    e.preventDefault();
  };

  return (
    <div ref={boxRef} tabIndex={0} role="region" aria-label="Page preview" aria-busy={loading || undefined} onKeyDown={onKeyDown} className="size-full overflow-auto p-6 [scrollbar-gutter:stable]">
      <div data-testid="page-frame" className="relative mx-auto bg-white shadow-lg ring-1 ring-slate-300 dark:ring-slate-700" style={{ width: shownWidth, aspectRatio: `${info.width_pt} / ${info.height_pt}` }}>
        {url ? <RotatedPage url={url} info={source} rot={entry.rot} alt={`Page ${page} of ${plan.length}`} /> : <div className="skeleton absolute inset-0" aria-hidden />}
        {url && <AnnotationLayer key={entry.src} srcPage={entry.src} info={source} rot={entry.rot} interactive={canAnnotate} />}
        {loading && url === null && (
          <span role="status" className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-slate-900/80 px-3 py-1.5 text-xs text-white">
            Drawing page {page}…
          </span>
        )}
      </div>
      {failed && (
        <div role="alert" className="mx-auto mt-4 flex max-w-lg flex-col items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-950 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100">
          <p>
            <strong className="font-semibold">Page {page} couldn't be drawn.</strong> {failed.message}
          </p>
          <Button size="sm" icon={<RefreshCw className="size-4" aria-hidden />} onClick={() => setRetry((n) => n + 1)}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}
