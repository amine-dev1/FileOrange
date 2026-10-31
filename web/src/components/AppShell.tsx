import { Clock, FileText, House, Info, Menu, Monitor, Moon, RefreshCw, Sun, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useCapabilities } from "../state/CapabilitiesProvider";
import { isActive, useJobs } from "../state/JobsProvider";
import { useTheme, type ThemeChoice } from "../state/ThemeProvider";
import { api } from "../lib/api";
import { formatBytes, formatLimit } from "../lib/format";
import { TOOLS } from "../lib/tools";
import type { MeResponse } from "../lib/types";
import { Badge, Button, ProgressBar, cx } from "./ui";

const NAV = [
  { to: "/app", label: "Dashboard", Icon: House, end: true },
  { to: "/convert", label: "Convert", Icon: TOOLS[0].Icon },
  { to: "/pdf", label: "PDF tools", Icon: FileText },
  { to: "/compress", label: "Compress", Icon: TOOLS[1].Icon },
  { to: "/extract", label: "Extract", Icon: TOOLS[2].Icon },
  { to: "/jobs", label: "Recent jobs", Icon: Clock },
  { to: "/about", label: "About", Icon: Info },
];

function ThemeSwitch() {
  const { choice, setChoice } = useTheme();
  const opts: { v: ThemeChoice; label: string; Icon: typeof Sun }[] = [
    { v: "light", label: "Light", Icon: Sun },
    { v: "system", label: "Match my device", Icon: Monitor },
    { v: "dark", label: "Dark", Icon: Moon },
  ];
  return (
    <div role="radiogroup" aria-label="Colour theme" className="inline-flex rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800">
      {opts.map(({ v, label, Icon }) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={choice === v}
          aria-label={label}
          title={label}
          onClick={() => setChoice(v)}
          className={cx("grid size-7 place-items-center rounded-md", choice === v ? "bg-white text-brand-700 shadow-sm dark:bg-slate-950 dark:text-brand-300" : "text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200")}
        >
          <Icon className="size-4" aria-hidden />
        </button>
      ))}
    </div>
  );
}

/** "Today: 12 MB of 600 MB": only on a hosted server, where a visitor has a daily allowance. */
function UsageMeter() {
  const { jobs } = useJobs();
  const [me, setMe] = useState<MeResponse | null>(null);
  const finished = jobs.filter((j) => !isActive(j)).length;
  useEffect(() => {
    let stale = false;
    api
      .me()
      .then((m) => !stale && setMe(m))
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [finished]);
  if (!me || me.tier === "local" || me.limits.daily_bytes == null) return null;
  const pct = Math.min(100, (me.usage.bytes_today / me.limits.daily_bytes) * 100);
  return (
    <div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-800/60 dark:text-slate-400" aria-label="Today's allowance">
      <p className="mb-1.5 font-medium text-slate-800 dark:text-slate-200">
        Today: {formatBytes(me.usage.bytes_today)} of {formatLimit(me.limits.daily_bytes)}
      </p>
      <ProgressBar percent={pct} label="Today's upload allowance used" />
      <p className="mt-1.5">Resets at midnight UTC.</p>
    </div>
  );
}

function Brand() {
  return (
    <Link to="/" className="flex items-center gap-2.5 rounded-lg px-2" aria-label="OrangeFile home">
      <img src="/logo.png" alt="" width={32} height={32} className="size-8 rounded-lg" />
      <span className="text-lg font-bold tracking-tight text-slate-900 dark:text-slate-50">OrangeFile</span>
    </Link>
  );
}

function ServiceBanner(): ReactNode {
  const { state, reload } = useCapabilities();
  if (state.status !== "error") return null;
  return (
    <div role="alert" className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100">
      <span>
        <strong className="font-semibold">The processing service isn't reachable.</strong> {state.message}
      </span>
      <Button size="sm" icon={<RefreshCw className="size-4" aria-hidden />} onClick={reload}>
        Try again
      </Button>
    </div>
  );
}

export function AppShell() {
  const { jobs } = useJobs();
  const location = useLocation();
  // The menu belongs to the page it was opened on, so moving to another page closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === location.pathname;
  const setOpen = (fn: (o: boolean) => boolean) => setOpenOn(fn(open) ? location.pathname : null);
  const running = jobs.filter(isActive).length;

  const nav = (
    <nav aria-label="Main" className="flex flex-col gap-1">
      {NAV.map(({ to, label, Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive: on }) =>
            cx(
              "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
              on || (to === "/pdf" && location.pathname.startsWith("/pdf")) ? "bg-brand-100 text-brand-900 dark:bg-brand-900/30 dark:text-brand-200" : "text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800",
            )
          }
        >
          <Icon className="size-5" aria-hidden />
          <span className="flex-1">{label}</span>
          {to === "/jobs" && running > 0 && <Badge tone="brand">{running} running</Badge>}
        </NavLink>
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[16rem_1fr]">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:shadow-lg dark:focus:bg-slate-900">
        Skip to content
      </a>
      {/* Wide screens: a fixed sidebar. */}
      <aside className="sticky top-0 hidden h-screen flex-col gap-6 border-r border-slate-200 bg-white p-4 lg:flex dark:border-slate-800 dark:bg-slate-900">
        <Brand />
        {nav}
        <div className="mt-auto flex flex-col gap-3">
          <UsageMeter />
          <div className="px-2">
            <ThemeSwitch />
          </div>
        </div>
      </aside>

      {/* Narrow screens: a top bar with a menu. */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur lg:hidden dark:border-slate-800 dark:bg-slate-900/95">
        <Brand />
        <button type="button" aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} aria-controls="mobile-nav" onClick={() => setOpen((o) => !o)} className="grid size-10 place-items-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800">
          {open ? <X className="size-5" aria-hidden /> : <Menu className="size-5" aria-hidden />}
        </button>
      </header>
      {open && (
        <div id="mobile-nav" className="fixed inset-x-0 top-[3.75rem] z-20 flex flex-col gap-4 border-b border-slate-200 bg-white p-4 shadow-lg lg:hidden dark:border-slate-800 dark:bg-slate-900">
          {nav}
          <UsageMeter />
          <ThemeSwitch />
        </div>
      )}

      <main id="main" tabIndex={-1} className="min-w-0 px-4 py-6 sm:px-8 lg:py-8">
        <div className="mx-auto max-w-5xl">
          <ServiceBanner />
          <Outlet />
        </div>
      </main>
    </div>
  );
}
