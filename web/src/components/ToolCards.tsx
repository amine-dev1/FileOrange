import { Link } from "react-router-dom";
import { operationState } from "../lib/capabilities";
import { TOOLS, type ToolDef } from "../lib/tools";
import { useCapabilities } from "../state/CapabilitiesProvider";
import { Badge, cx } from "./ui";
import { t } from "../lib/i18n";

function ToolCard({ tool }: { tool: ToolDef }) {
  const { caps } = useCapabilities();
  const st = caps && !tool.local ? operationState(caps, tool.op) : null;
  const off = st !== null && st.state !== "ready";
  const body = (
    <>
      <span className={cx("grid size-11 place-items-center rounded-xl", off ? "bg-slate-100 text-slate-400 dark:bg-slate-800" : "bg-brand-100 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300")}>
        <tool.Icon className="size-6" aria-hidden />
      </span>
      <span className="flex flex-col gap-1">
        <span className="flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100">
          {t(tool.title)}
          {st?.state === "unavailable" && <Badge tone="amber">{t("Unavailable")}</Badge>}
          {st?.state === "missing" && <Badge>{t("Not in this version")}</Badge>}
        </span>
        <span className="text-sm text-slate-600 dark:text-slate-400">{t(off ? st.reason : tool.description)}</span>
      </span>
    </>
  );
  const base = "flex gap-4 rounded-2xl border bg-white p-4 text-left shadow-sm transition dark:bg-slate-900";
  if (off)
    return (
      <div aria-disabled="true" className={cx(base, "cursor-not-allowed border-slate-200 opacity-70 dark:border-slate-800")}>
        {body}
      </div>
    );
  return (
    <Link to={tool.path} className={cx(base, "border-slate-200 hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md dark:border-slate-800 dark:hover:border-brand-700")}>
      {body}
    </Link>
  );
}

/** Cards for the tools of a group. A tool the engine can't run is shown with the reason, not hidden and not clickable. */
export function ToolCards({ group }: { group?: ToolDef["group"] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {TOOLS.filter((d) => !group || d.group === group).map((d) => (
        <ToolCard key={d.op} tool={d} />
      ))}
    </div>
  );
}
