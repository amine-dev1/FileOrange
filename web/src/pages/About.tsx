import { PageHeader } from "../components/ToolShell";
import { Badge, Callout, Card } from "../components/ui";
import { formatLabel } from "../lib/capabilities";
import { formatBytes, formatLimit } from "../lib/format";
import { useCapabilities } from "../state/CapabilitiesProvider";
import type { Availability } from "../lib/types";

function Status({ a }: { a: Availability }) {
  if (a.status === "bundled") return <Badge tone="green">Built in</Badge>;
  if (a.status === "installed") return <Badge tone="green">Installed on the server</Badge>;
  return <Badge tone="red">Unavailable</Badge>;
}

export function About() {
  const { state } = useCapabilities();
  if (state.status !== "ready")
    return (
      <>
        <PageHeader title="About" />
        <Callout tone={state.status === "error" ? "error" : "info"}>{state.status === "error" ? state.message : "Loading…"}</Callout>
      </>
    );
  const { caps } = state;
  const l = caps.limits;
  const minutes = l.retention_seconds ? Math.round(l.retention_seconds / 60) : null;
  return (
    <>
      <PageHeader title="About this service" subtitle="What the server behind this page can do right now, as it reports it. Nothing on this site is a guess." />
      <div className="flex flex-col gap-5">
        <Card title="Engines">
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {caps.engines.map((e) => (
              <li key={e.id} className="flex flex-wrap items-start justify-between gap-2 py-3">
                <div>
                  <p className="font-medium text-slate-900 dark:text-slate-100">{e.name}</p>
                  <p className="text-xs text-slate-600 dark:text-slate-400">
                    {e.version} · {e.license}
                  </p>
                  {e.availability.status === "unavailable" && <p className="mt-1 text-sm text-red-700 dark:text-red-300">{e.availability.reason}</p>}
                </div>
                <Status a={e.availability} />
              </li>
            ))}
          </ul>
        </Card>

        <Card title="What it can do">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Operations</caption>
              <thead className="text-xs uppercase tracking-wide text-slate-600 dark:text-slate-400">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-semibold">Operation</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">Reads</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">Writes</th>
                  <th scope="col" className="py-2 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {caps.operations.map((o) => (
                  <tr key={o.id}>
                    <th scope="row" className="py-2 pr-4 font-medium text-slate-900 dark:text-slate-100">{o.label}</th>
                    <td className="py-2 pr-4 text-slate-600 dark:text-slate-400">{o.inputs.length ? o.inputs.map((i) => formatLabel(caps, i)).join(", ") : "Any file"}</td>
                    <td className="py-2 pr-4 text-slate-600 dark:text-slate-400">{o.outputs.length ? o.outputs.map((i) => formatLabel(caps, i)).join(", ") : "ZIP / files"}</td>
                    <td className="py-2">{o.available ? <Badge tone="green">Available</Badge> : <span title={o.unavailable_reason ?? undefined}><Badge tone="red">Unavailable</Badge></span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Image conversions">
          {caps.operations
            .filter((o) => o.pairs.length > 0)
            .map((o) => (
              <div key={o.id} className="mb-4 last:mb-0">
                <h3 className="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">{o.label}</h3>
                <ul className="flex flex-wrap gap-1.5">
                  {o.pairs.map((p) => (
                    <li key={`${p.from}-${p.to}`}>
                      <Badge>
                        {formatLabel(caps, p.from)} → {formatLabel(caps, p.to)}
                      </Badge>
                    </li>
                  ))}
                </ul>
                {o.pairs.some((p) => p.notes.length) && (
                  <details className="mt-2 text-sm">
                    <summary className="cursor-pointer text-slate-600 dark:text-slate-400">What changes in each conversion</summary>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-600 dark:text-slate-400">
                      {[...new Set(o.pairs.flatMap((p) => p.notes))].map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            ))}
        </Card>

        <Card title="Limits and privacy">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {l.max_files != null && <Row k="Files per job" v={String(l.max_files)} />}
            {l.max_file_bytes != null && <Row k="Largest file" v={formatLimit(l.max_file_bytes)} />}
            {l.max_request_bytes != null && <Row k="Largest job" v={formatBytes(l.max_request_bytes)} />}
            <Row k="Largest image" v={`${l.max_image_dimension.toLocaleString()} px a side`} />
            <Row k="Largest WebP image" v={`${l.max_webp_dimension.toLocaleString()} px a side`} />
            {minutes != null && <Row k="Results are kept" v={`about ${minutes} minutes, then deleted`} />}
          </dl>
          <p className="mt-4 text-sm text-slate-600 dark:text-slate-400">Your originals are never changed. Each job runs in its own private folder, and archives, PDFs and Office documents are opened by separate, time-limited processes.</p>
        </Card>
      </div>
    </>
  );
}

const Row = ({ k, v }: { k: string; v: string }) => (
  <div className="flex justify-between gap-4 border-b border-slate-100 py-1 dark:border-slate-800">
    <dt className="text-slate-600 dark:text-slate-400">{k}</dt>
    <dd className="font-medium text-slate-900 dark:text-slate-100">{v}</dd>
  </div>
);
