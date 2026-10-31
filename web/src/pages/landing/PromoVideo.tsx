import { Play } from "lucide-react";
import { useEffect, useState } from "react";
import { t, useLang, type Lang } from "../../lib/i18n";

/**
 * "See it in action": the presentation video, in the visitor's language when it exists, otherwise the other one.
 * Files live in public/video/: orangefile-<lang>.mp4, orangefile-<lang>.vtt (captions) and orangefile-poster.jpg.
 * Until a video file is there, the section is not shown at all (the site's fallback page is HTML, not video, so it is told apart).
 */
const BASE = "/video/orangefile";

async function hasVideo(lang: Lang): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}-${lang}.mp4`, { method: "HEAD" });
    return r.ok && (r.headers.get("content-type") ?? "").startsWith("video/");
  } catch {
    return false;
  }
}

export function PromoVideo() {
  const lang = useLang();
  const [found, setFound] = useState<Lang | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      for (const l of [lang, lang === "fr" ? "en" : "fr"] as Lang[]) {
        if (await hasVideo(l)) {
          if (live) setFound(l);
          return;
        }
      }
      if (live) setFound(null);
    })();
    return () => {
      live = false;
    };
  }, [lang]);

  if (!found) return null;
  return (
    <section id="video" aria-labelledby="video-heading" className="scroll-mt-20 px-4 pt-20 sm:px-6 sm:pt-28">
      <div className="mx-auto max-w-5xl">
        <div data-reveal className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="font-mono text-xs font-bold tracking-[0.18em] text-tangerine-deep uppercase dark:text-tangerine-soft">
              <Play className="mr-1 inline size-3.5 -translate-y-px" aria-hidden />
              {t("See it in action")}
            </p>
            <h2 id="video-heading" className="mt-3 font-display text-4xl font-bold tracking-tight sm:text-5xl">
              {t("A minute with Ora.")}
            </h2>
          </div>
          <p className="max-w-sm text-aubergine-muted dark:text-night-muted">{t("Every tool, shown in 60 seconds. Sound on, or read the captions.")}</p>
        </div>
        <div data-reveal className="overflow-hidden rounded-[1.75rem] border-2 border-aubergine bg-aubergine shadow-[8px_8px_0_0_var(--color-tangerine)] dark:border-peel/20">
          {/* key: a new language loads the other file and captions */}
          <video key={found} className="aspect-video w-full bg-aubergine" controls preload="metadata" playsInline poster={`${BASE}-poster.jpg`} data-testid="promo-video">
            <source src={`${BASE}-${found}.mp4`} type="video/mp4" />
            <track kind="captions" src={`${BASE}-${found}.vtt`} srcLang={found} label={found === "fr" ? "Français" : "English"} default />
          </video>
        </div>
      </div>
    </section>
  );
}
