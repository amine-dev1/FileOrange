import {
  ArrowRight,
  ArrowUpRight,
  Download,
  EyeOff,
  Files,
  FileText,
  FolderArchive,
  Heart,
  Image,
  MapPin,
  MousePointerClick,
  Plus,
  Timer,
  Upload,
  UserX,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { DONATE_URL } from "../../lib/donate";
import { formatLimit } from "../../lib/format";
import { useCapabilities } from "../../state/CapabilitiesProvider";
import { ConversionMachine } from "./ConversionMachine";
import "./landing.css";

/** Adds `is-in` to every [data-reveal] element once it scrolls into view. */
function useReveal() {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const els = Array.from(
      root.current?.querySelectorAll<HTMLElement>("[data-reveal]") ?? [],
    );
    if (!("IntersectionObserver" in window)) {
      els.forEach((e) => e.classList.add("is-in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("is-in");
            io.unobserve(e.target);
          }
        }),
      { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);
  return root;
}

const GROUPS: {
  title: string;
  formats: string;
  Icon: typeof Image;
  tools: { name: string; what: string; flow: string; to: string }[];
}[] = [
  {
    title: "Pictures",
    formats: "JPG · PNG · WEBP",
    Icon: Image,
    tools: [
      {
        name: "Convert images",
        what: "Change the format, keep the picture.",
        flow: ".png → .jpg",
        to: "/convert",
      },
      {
        name: "Resize and compress",
        what: "Smaller dimensions, or a file size you choose.",
        flow: "4 MB → 300 KB",
        to: "/resize",
      },
      {
        name: "Pictures to PDF",
        what: "One page per picture, in the order you choose.",
        flow: ".jpg ×4 → .pdf",
        to: "/pdf/images-to-pdf",
      },
    ],
  },
  {
    title: "PDFs",
    formats: "PDF, even password-protected",
    Icon: FileText,
    tools: [
      {
        name: "Edit and annotate",
        what: "Reorder, rotate, delete pages; draw, highlight, add text.",
        flow: ".pdf → .pdf",
        to: "/pdf/editor",
      },
      {
        name: "Sign a PDF",
        what: "Draw, type or upload your signature, then place it.",
        flow: ".pdf → signed .pdf",
        to: "/pdf/editor?sign=1",
      },
      {
        name: "Merge PDFs",
        what: "Several files into one, in your order.",
        flow: ".pdf ×3 → .pdf",
        to: "/pdf/merge",
      },
      {
        name: "Split a PDF",
        what: "By page ranges, or every few pages.",
        flow: ".pdf → .pdf ×n",
        to: "/pdf/split",
      },
      {
        name: "PDF to pictures",
        what: "Every page as a JPG or PNG.",
        flow: ".pdf → .jpg ×n",
        to: "/pdf/to-images",
      },
    ],
  },
  {
    title: "Documents",
    formats: "Word · Excel · PowerPoint · OpenDocument",
    Icon: Files,
    tools: [
      {
        name: "Documents to PDF",
        what: "Layout, fonts and pages kept, ready to send or print.",
        flow: ".docx → .pdf",
        to: "/pdf/documents-to-pdf",
      },
    ],
  },
  {
    title: "Folders and archives",
    formats: "Folders · ZIP",
    Icon: FolderArchive,
    tools: [
      {
        name: "Compress to ZIP",
        what: "A folder or a pile of files into one ZIP.",
        flow: "folder/ → .zip",
        to: "/compress",
      },
      {
        name: "Extract a ZIP",
        what: "Unpack it safely, folders included.",
        flow: ".zip → folder/",
        to: "/extract",
      },
    ],
  },
];

function Section({
  id,
  children,
  className = "",
}: {
  id?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={`scroll-mt-20 px-4 sm:px-6 ${className}`}>
      <div className="mx-auto max-w-6xl">{children}</div>
    </section>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="font-mono text-xs font-bold tracking-[0.18em] text-tangerine-deep uppercase dark:text-tangerine-soft">
      {children}
    </p>
  );
}

function Faq({ q, children }: { q: string; children: ReactNode }) {
  return (
    <details className="group border-b-2 border-aubergine/15 py-5 dark:border-peel/15">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-6 font-display text-lg font-semibold text-aubergine marker:hidden dark:text-peel [&::-webkit-details-marker]:hidden">
        {q}
        <Plus
          className="size-5 shrink-0 transition-transform duration-300 group-open:rotate-45"
          aria-hidden
        />
      </summary>
      <div className="mt-3 max-w-2xl text-aubergine-muted dark:text-night-muted">
        {children}
      </div>
    </details>
  );
}

export function Landing() {
  const root = useReveal();
  const caps = useCapabilities().caps;
  const perFile = caps?.limits.max_file_bytes
    ? formatLimit(caps.limits.max_file_bytes)
    : "100 MB";
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    document.title =
      "OrangeFile: convert, merge and edit files in your browser";
    const on = () => setScrolled(window.scrollY > 24);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => {
      window.removeEventListener("scroll", on);
      document.title = "OrangeFile";
    };
  }, []);

  return (
    <div
      ref={root}
      className="min-h-screen bg-peel font-sans text-aubergine dark:bg-night dark:text-peel"
    >
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-aubergine focus:px-4 focus:py-2 focus:text-peel"
      >
        Skip to content
      </a>

      {/* ------------------------------------------------------------------ navigation */}
      <header
        className={`fixed inset-x-0 top-0 z-40 transition-[background-color,box-shadow] duration-300 ${scrolled ? "bg-peel/90 shadow-[0_1px_0_0_rgb(43_15_46/0.12)] backdrop-blur-md dark:bg-night/90" : ""}`}
      >
        <nav
          aria-label="Main"
          className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6"
        >
          <Link to="/" className="flex items-center gap-2.5 rounded-lg">
            <img
              src="/logo.png"
              alt=""
              width={32}
              height={32}
              className="size-8 rounded-lg"
            />
            <span
              className={`font-display text-xl font-bold tracking-tight ${scrolled ? "text-aubergine dark:text-peel" : "text-aubergine"}`}
            >
              OrangeFile
            </span>
          </Link>
          <div className="hidden items-center gap-7 text-sm font-semibold md:flex">
            {[
              ["#tools", "Tools"],
              ["#how", "How it works"],
              ["#privacy", "Privacy"],
              ["#faq", "Questions"],
            ].map(([href, label]) => (
              <a
                key={href}
                href={href}
                className={`underline-offset-4 hover:underline ${scrolled ? "text-aubergine dark:text-peel" : "text-aubergine"}`}
              >
                {label}
              </a>
            ))}
          </div>
          <Link
            to="/app"
            className="inline-flex items-center gap-2 rounded-full bg-aubergine px-4 py-2 text-sm font-semibold text-peel transition-transform hover:-translate-y-0.5 dark:border dark:border-peel/20"
          >
            Open the app <ArrowRight className="size-4" aria-hidden />
          </Link>
        </nav>
      </header>

      <main id="main">
        {/* ------------------------------------------------------------------ hero */}
        <div className="lp-field relative overflow-hidden pt-28 pb-20 sm:pt-36 sm:pb-28">
          <div className="mx-auto grid max-w-6xl items-center gap-14 px-4 sm:px-6 lg:grid-cols-[1.1fr_1fr] lg:gap-10">
            <div>
              <p
                className="lp-rise font-mono text-xs font-bold tracking-[0.18em] text-aubergine uppercase"
                style={{ animationDelay: "0ms" }}
              >
                .jpg .png .webp .pdf .docx .xlsx .pptx .zip
              </p>
              <h1 className="mt-5 font-display text-[clamp(2.6rem,6.2vw,5.25rem)] leading-[0.95] font-extrabold tracking-[-0.035em] text-aubergine">
                {["Turn the file", "you have into", "the one"].map(
                  (line, n) => (
                    <span
                      key={line}
                      className="lp-rise block"
                      style={{ animationDelay: `${90 + n * 90}ms` }}
                    >
                      {line}
                    </span>
                  ),
                )}
                <span
                  className="lp-rise block"
                  style={{ animationDelay: "360ms" }}
                >
                  <span className="lp-marker">you need.</span>
                </span>
              </h1>
              <p
                className="lp-rise mt-7 max-w-xl text-lg leading-relaxed text-aubergine"
                style={{ animationDelay: "450ms" }}
              >
                Convert pictures, merge and edit PDFs, turn Word, Excel and
                PowerPoint files into PDF, and zip folders, right in your
                browser. Free, no account, and your files are deleted 15 minutes
                after they're ready.
              </p>
              <div
                className="lp-rise mt-9 flex flex-wrap gap-3"
                style={{ animationDelay: "540ms" }}
              >
                <Link
                  to="/app"
                  className="group inline-flex items-center gap-2.5 rounded-full bg-aubergine px-7 py-4 text-base font-semibold text-peel shadow-[4px_4px_0_0_var(--color-peel)] transition-transform hover:-translate-y-0.5"
                >
                  Open OrangeFile
                  <ArrowRight
                    className="size-5 transition-transform group-hover:translate-x-1"
                    aria-hidden
                  />
                </Link>
                <a
                  href="#tools"
                  className="inline-flex items-center gap-2 rounded-full border-2 border-aubergine px-7 py-4 text-base font-semibold text-aubergine transition-colors hover:bg-aubergine/10"
                >
                  See every tool
                </a>
              </div>
              <ul
                className="lp-rise mt-9 flex flex-wrap gap-x-6 gap-y-2 font-mono text-xs font-semibold text-aubergine"
                style={{ animationDelay: "630ms" }}
              >
                <li>✓ No sign-up</li>
                <li>✓ Up to {perFile} per file</li>
                <li>✓ Deleted after 15 min</li>
              </ul>
            </div>
            <div className="lp-rise" style={{ animationDelay: "300ms" }}>
              <ConversionMachine />
            </div>
          </div>
        </div>

        {/* ------------------------------------------------------------------ tools, grouped by what you start with */}
        <Section id="tools" className="py-24 sm:py-32">
          <div data-reveal className="max-w-2xl">
            <Eyebrow>Tools</Eyebrow>
            <h2 className="mt-3 font-display text-4xl font-bold tracking-tight sm:text-5xl">
              Start from what you have.
            </h2>
            <p className="mt-4 text-lg text-aubergine-muted dark:text-night-muted">
              Pick the kind of file in front of you. Every tool opens straight
              away, nothing to install.
            </p>
          </div>
          <div className="mt-14 grid items-start gap-5 md:grid-cols-2">
            {[
              [GROUPS[1], GROUPS[2]],
              [GROUPS[0], GROUPS[3]],
            ].map((col, ci) => (
              <div key={ci} className="grid gap-5">
                {col.map((g, gi) => (
                  <div
                    key={g.title}
                    data-reveal
                    style={
                      { "--d": `${(ci + gi) * 90}ms` } as React.CSSProperties
                    }
                    className="lp-lift rounded-3xl border-2 border-aubergine bg-white/60 p-6 dark:border-peel/20 dark:bg-aubergine/60 sm:p-7"
                  >
                    <div className="flex items-start gap-4">
                      <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-tangerine text-aubergine">
                        <g.Icon className="size-6" aria-hidden />
                      </span>
                      <div>
                        <h3 className="font-display text-2xl font-bold tracking-tight">
                          {g.title}
                        </h3>
                        <p className="mt-0.5 font-mono text-xs font-semibold text-aubergine-muted dark:text-night-muted">
                          {g.formats}
                        </p>
                      </div>
                    </div>
                    <ul className="mt-6 divide-y-2 divide-aubergine/10 dark:divide-peel/10">
                      {g.tools.map((t) => (
                        <li key={t.to}>
                          <Link
                            to={t.to}
                            className="lp-tool -mx-3 flex items-center gap-4 rounded-xl px-3 py-3.5 transition-colors hover:bg-pith/60 dark:hover:bg-peel/10"
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block font-semibold">
                                {t.name}
                              </span>
                              <span className="block text-sm text-aubergine-muted dark:text-night-muted">
                                {t.what}
                              </span>
                            </span>
                            <span className="hidden font-mono text-xs font-semibold whitespace-nowrap text-tangerine-deep sm:block dark:text-tangerine-soft">
                              {t.flow}
                            </span>
                            <ArrowUpRight
                              className="lp-arrow size-5 shrink-0"
                              aria-hidden
                            />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Section>

        {/* ------------------------------------------------------------------ how it works: a real sequence */}
        <Section
          id="how"
          className="border-y-2 border-aubergine/10 bg-pith/40 py-24 sm:py-28 dark:border-peel/10 dark:bg-aubergine/40"
        >
          <div data-reveal className="max-w-2xl">
            <Eyebrow>How it works</Eyebrow>
            <h2 className="mt-3 font-display text-4xl font-bold tracking-tight sm:text-5xl">
              Three steps. Usually under a minute.
            </h2>
          </div>
          <div data-reveal className="relative mt-16">
            <div
              aria-hidden
              className="lp-track absolute top-7 right-[16%] left-[16%] hidden h-0.5 bg-aubergine/30 md:block dark:bg-peel/30"
            />
            <ol className="relative grid gap-12 md:grid-cols-3 md:gap-8">
              {[
                {
                  Icon: Upload,
                  title: "Drop your files",
                  text: "Drag them onto the page or pick them from your computer. A whole folder works too.",
                },
                {
                  Icon: MousePointerClick,
                  title: "Choose what you want",
                  text: "The format, the pages, the order. Only options that make sense for your files are shown.",
                },
                {
                  Icon: Download,
                  title: "Download the result",
                  text: "One click. Several files come back together in a single ZIP.",
                },
              ].map((s, n) => (
                <li key={s.title} className="text-center md:px-4">
                  <span className="relative mx-auto grid size-14 place-items-center rounded-full border-2 border-aubergine bg-tangerine text-aubergine dark:border-peel/30">
                    <s.Icon className="size-6" aria-hidden />
                    <span className="absolute -top-2 -right-2 grid size-6 place-items-center rounded-full bg-aubergine font-mono text-xs font-bold text-peel dark:bg-peel dark:text-aubergine">
                      {n + 1}
                    </span>
                  </span>
                  <h3 className="mt-5 font-display text-xl font-bold">
                    {s.title}
                  </h3>
                  <p className="mx-auto mt-2 max-w-xs text-aubergine-muted dark:text-night-muted">
                    {s.text}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </Section>

        {/* ------------------------------------------------------------------ privacy */}
        <Section id="privacy" className="py-24 sm:py-32">
          <div className="overflow-hidden rounded-[2rem] bg-aubergine text-peel dark:border-2 dark:border-peel/15">
            <div className="grid gap-12 p-8 sm:p-12 lg:grid-cols-[1fr_1.1fr] lg:p-16">
              <div data-reveal>
                <p className="font-mono text-xs font-bold tracking-[0.18em] text-mint uppercase">
                  Privacy
                </p>
                <h2 className="mt-3 font-display text-4xl leading-[1.02] font-bold tracking-tight sm:text-6xl">
                  We don't keep
                  <br />
                  your files.
                </h2>
                <p className="mt-6 max-w-md text-lg text-night-muted">
                  They exist on our server only as long as it takes to process
                  them and for you to download the result.
                </p>
              </div>
              <ul className="grid gap-4 sm:grid-cols-2">
                {[
                  {
                    Icon: Timer,
                    title: "Deleted after 15 minutes",
                    text: "Originals and results are removed automatically once the result has been ready for 15 minutes.",
                  },
                  {
                    Icon: UserX,
                    title: "No account, no email",
                    text: "Nothing to sign up for. Your browser gets an anonymous session that only serves to keep your jobs apart from others'.",
                  },
                  {
                    Icon: EyeOff,
                    title: "Never in our logs",
                    text: "Logs record that a request happened, never file names or what's inside them.",
                  },
                  {
                    Icon: MapPin,
                    title: "Processed in Paris",
                    text: "Files are handled on one server in France and aren't passed to other services.",
                  },
                ].map((p, n) => (
                  <li
                    key={p.title}
                    data-reveal
                    style={{ "--d": `${n * 80}ms` } as React.CSSProperties}
                    className="rounded-2xl border border-peel/15 bg-night/40 p-5"
                  >
                    <p.Icon className="size-6 text-mint" aria-hidden />
                    <h3 className="mt-3 font-semibold">{p.title}</h3>
                    <p className="mt-1.5 text-sm text-night-muted">{p.text}</p>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Section>

        {/* ------------------------------------------------------------------ questions */}
        <Section id="faq" className="pb-24 sm:pb-32">
          <div className="grid gap-10 lg:grid-cols-[1fr_2fr]">
            <div data-reveal>
              <Eyebrow>Questions</Eyebrow>
              <h2 className="mt-3 font-display text-4xl font-bold tracking-tight sm:text-5xl">
                Good to know.
              </h2>
            </div>
            <div data-reveal>
              <Faq q="Is it really free?">
                Yes. There is no paid plan and no account. To keep it fair for
                everyone there is a daily upload allowance per visitor, shown in
                the app, which resets at midnight UTC.
              </Faq>
              <Faq q="How big can my files be?">
                Up to {perFile} per file. You can send several files at once for
                tools such as merging PDFs or making a ZIP.
              </Faq>
              <Faq q="Can I open a password-protected PDF?">
                Yes, if you know the password. You type it in your browser; it's
                used to open the file and isn't stored.
              </Faq>
              <Faq q="Will my Word document look the same as a PDF?">
                In most cases, yes: pages, fonts and images are kept. Documents
                that rely on fonts we don't have, or on unusual layout features,
                can come out slightly different, so check the result before you
                send it.
              </Faq>
              <Faq q="What happens to my files afterwards?">
                They are deleted from the server automatically, 15 minutes after
                the result is ready. Download it before then.
              </Faq>
            </div>
          </div>
        </Section>

        {/* ------------------------------------------------------------------ last call */}
        <Section className="pb-24">
          <div
            data-reveal
            className="lp-field relative overflow-hidden rounded-[2rem] border-2 border-aubergine px-6 py-16 text-center sm:px-12 sm:py-20"
          >
            <h2 className="mx-auto max-w-3xl font-display text-4xl leading-[1.02] font-extrabold tracking-tight text-aubergine sm:text-6xl">
              Got a file in the wrong format?
            </h2>
            <p className="mx-auto mt-5 max-w-xl text-lg text-aubergine">
              Fix it now. It takes less time than reading this sentence twice.
            </p>
            <Link
              to="/app"
              className="group mt-9 inline-flex items-center gap-2.5 rounded-full bg-aubergine px-8 py-4 text-base font-semibold text-peel shadow-[4px_4px_0_0_var(--color-peel)] transition-transform hover:-translate-y-0.5"
            >
              Open OrangeFile{" "}
              <ArrowRight
                className="size-5 transition-transform group-hover:translate-x-1"
                aria-hidden
              />
            </Link>
          </div>
        </Section>
        {DONATE_URL && (
          <>
            {/* ------------------------------------------------------------------ support */}
            <Section id="support" className="pb-24">
              <div
                data-reveal
                className="grid items-center gap-8 rounded-[2rem] border-2 border-aubergine bg-mint p-8 text-aubergine sm:p-12 md:grid-cols-[1.4fr_1fr]"
              >
                <div>
                  <p className="font-mono text-xs font-bold tracking-[0.18em] uppercase">
                    Support
                  </p>
                  <h2 className="mt-3 font-display text-4xl leading-[1.02] font-bold tracking-tight sm:text-5xl">
                    Free, no ads. Kept going by people like you.
                  </h2>
                  <p className="mt-4 max-w-xl text-lg">
                    OrangeFile is made by one developer. If it saved you time, a
                    donation helps pay for the server and for the next tools.
                  </p>
                </div>
                <div className="flex flex-col items-start gap-3 md:items-end">
                  <a
                    href={DONATE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group inline-flex items-center gap-2.5 rounded-full bg-aubergine px-8 py-4 text-base font-semibold text-peel shadow-[4px_4px_0_0_var(--color-peel)] transition-transform hover:-translate-y-0.5"
                  >
                    <Heart
                      className="size-5 transition-transform group-hover:scale-110"
                      aria-hidden
                    />
                    Donate with PayPal
                    <span className="sr-only">(opens in a new tab)</span>
                  </a>
                  <p className="font-mono text-xs font-semibold">
                    Any amount · card or PayPal account
                  </p>
                </div>
              </div>
            </Section>
          </>
        )}
      </main>

      <footer className="border-t-2 border-aubergine/10 px-4 py-10 sm:px-6 dark:border-peel/10">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-6 text-sm">
          <div className="flex items-center gap-2.5">
            <img
              src="/logo.png"
              alt=""
              width={24}
              height={24}
              className="size-6 rounded-md"
            />
            <span className="font-display font-bold">OrangeFile</span>
            <span className="text-aubergine-muted dark:text-night-muted">
              © {new Date().getFullYear()}
            </span>
          </div>
          <nav
            aria-label="Footer"
            className="flex flex-wrap gap-x-6 gap-y-2 font-semibold"
          >
            <Link to="/app" className="hover:underline">
              Open the app
            </Link>
            <a href="#tools" className="hover:underline">
              Tools
            </a>
            <a href="#privacy" className="hover:underline">
              Privacy
            </a>
            {DONATE_URL && (
              <a
                href={DONATE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:underline"
              >
                Donate<span className="sr-only"> (opens in a new tab)</span>
              </a>
            )}
            <Link to="/about" className="hover:underline">
              About and licences
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
