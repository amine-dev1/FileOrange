import { ApiError } from "./http";
import { t } from "./i18n";

/**
 * Cloudflare Turnstile, used only when the server asks for it (a new visitor on a hosted server with CAPTCHA switched on).
 * The widget is invisible unless Cloudflare wants a click; then it shows in a small card at the bottom of the screen.
 */
interface Turnstile {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  remove(id: string): void;
}
declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<void> | null = null;

function load(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => (window.turnstile ? resolve() : reject(new Error("no turnstile")));
    s.onerror = () => reject(new Error("blocked"));
    document.head.append(s);
  }).catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

/** One answer to the challenge, or an error the page can show. */
export async function turnstileAnswer(siteKey: string): Promise<string> {
  try {
    await load();
  } catch {
    throw new ApiError("CAPTCHA_UNAVAILABLE", t("The check that you're a person couldn't load. If an ad or tracker blocker is on, allow challenges.cloudflare.com, then reload."));
  }
  return new Promise<string>((resolve, reject) => {
    const card = document.createElement("div");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", t("Checking that you're a person"));
    card.className = "fixed inset-x-0 bottom-4 z-50 mx-auto w-fit max-w-[calc(100vw-2rem)] rounded-2xl bg-white p-3 shadow-2xl ring-1 ring-slate-200 empty:hidden dark:bg-slate-900 dark:ring-slate-700";
    const slot = document.createElement("div");
    card.append(slot);
    document.body.append(card);
    let id = "";
    const done = () => {
      try {
        if (id) window.turnstile?.remove(id);
      } catch {
        /* already gone */
      }
      card.remove();
    };
    id = window.turnstile!.render(slot, {
      sitekey: siteKey,
      appearance: "interaction-only",
      language: document.documentElement.lang || "auto",
      callback: (answer: string) => {
        done();
        resolve(answer);
      },
      "error-callback": () => {
        done();
        reject(new ApiError("CAPTCHA_FAILED", t("The check that you're a person didn't pass. Try again.")));
      },
      "timeout-callback": () => {
        done();
        reject(new ApiError("CAPTCHA_FAILED", t("The check that you're a person didn't pass. Try again.")));
      },
    });
  });
}
