/**
 * Fetches and remembers page images for one open PDF. Rendering happens in a separate
 * process, so requests are queued (a few at a time, previews before thumbnails) and every
 * result is kept as an object URL until the document is closed.
 */
export type PageFetcher = (page: number, width: number) => Promise<Blob>;

/** Images wider than this are page previews rather than thumbnails. */
const PREVIEW_MIN_WIDTH = 480;
/** Large images are kept only for a few recent views. */
const PREVIEW_CACHE = 12;

interface Waiting {
  priority: 0 | 1;
  run: () => void;
}

export class PageImages {
  private urls = new Map<string, string>();
  private previewKeys: string[] = [];
  private inflight = new Map<string, Promise<string>>();
  private waiting: Waiting[] = [];
  private active = 0;
  private disposed = false;

  constructor(
    private readonly fetchPage: PageFetcher,
    private readonly concurrency = 3,
  ) {}

  /** The image for `page` (from 1) drawn about `width` px wide. Repeat requests share one render. */
  url(page: number, width: number): Promise<string> {
    const key = `${page}:${width}`;
    const have = this.urls.get(key);
    if (have) {
      this.touch(key, width);
      return Promise.resolve(have);
    }
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const p = new Promise<string>((resolve, reject) => {
      this.waiting.push({
        priority: width >= PREVIEW_MIN_WIDTH ? 0 : 1,
        run: () => {
          this.fetchPage(page, width)
            .then((blob) => {
              if (this.disposed) throw new Error("closed");
              const url = URL.createObjectURL(blob);
              this.urls.set(key, url);
              this.touch(key, width);
              resolve(url);
            })
            .catch(reject)
            .finally(() => {
              this.inflight.delete(key);
              this.active--;
              this.pump();
            });
        },
      });
      this.pump();
    });
    this.inflight.set(key, p);
    return p;
  }

  private touch(key: string, width: number) {
    if (width < PREVIEW_MIN_WIDTH) return;
    this.previewKeys = this.previewKeys.filter((k) => k !== key);
    this.previewKeys.push(key);
    while (this.previewKeys.length > PREVIEW_CACHE) {
      const old = this.previewKeys.shift()!;
      const url = this.urls.get(old);
      if (url) URL.revokeObjectURL(url);
      this.urls.delete(old);
    }
  }

  private pump() {
    while (!this.disposed && this.active < this.concurrency && this.waiting.length > 0) {
      // Previews first; within a priority, the most recently asked-for (what's on screen now).
      let best = 0;
      for (let i = 1; i < this.waiting.length; i++) if (this.waiting[i].priority <= this.waiting[best].priority) best = i;
      const [next] = this.waiting.splice(best, 1);
      this.active++;
      next.run();
    }
  }

  dispose() {
    this.disposed = true;
    this.waiting = [];
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.previewKeys = [];
  }
}
