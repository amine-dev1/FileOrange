import { Check, Minus, RefreshCw } from "lucide-react";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { Card } from "../../components/Card";
import { PageHeader } from "../../components/PageHeader";
import { useCapabilities } from "../../app/CapabilitiesProvider";
import { formatLabel, labels } from "../../lib/capabilities";
import { formatBytes } from "../../lib/format";
import type { Capabilities, EngineInfo, OperationReport } from "../../lib/types";
import "./FormatsPage.css";

export function AvailabilityPill({ engine }: { engine: Pick<EngineInfo, "availability"> }) {
  const a = engine.availability;
  if (a.status === "unavailable") return <span className="pill pill--bad">Unavailable</span>;
  return <span className="pill pill--ok">{a.status === "bundled" ? "Built in" : "Installed"}</span>;
}

/** Everything the app can do, straight from the capability report. Nothing on this screen is typed by hand. */
export function FormatsPage() {
  const { state, caps, reload } = useCapabilities();
  return (
    <>
      <PageHeader title="Supported formats" subtitle="Exactly what this copy of OrangeFile can do, as reported by the app itself." />
      {state.status === "loading" && <p role="status" className="gate-note">Loading…</p>}
      {state.status === "error" && (
        <Callout tone="error" title="Couldn't load the list">
          <p>{state.message}</p>
          <Button size="sm" icon={<RefreshCw size={15} aria-hidden />} onClick={reload} className="gate-retry">
            Try again
          </Button>
        </Callout>
      )}
      {caps && (
        <div className="card-stack">
          <EnginesCard caps={caps} />
          {caps.operations.map((op) => (
            <OperationCard key={op.id} op={op} caps={caps} />
          ))}
          <LimitsCard caps={caps} />
        </div>
      )}
    </>
  );
}

function EnginesCard({ caps }: { caps: Capabilities }) {
  return (
    <Card title="Engines">
      <table className="plain-table">
        <caption className="sr-only">Engines</caption>
        <thead>
          <tr>
            <th scope="col">Engine</th>
            <th scope="col">Version</th>
            <th scope="col">Status</th>
            <th scope="col">License</th>
          </tr>
        </thead>
        <tbody>
          {caps.engines.map((e) => (
            <tr key={e.id}>
              <th scope="row">{e.name}</th>
              <td className="selectable">{e.version}</td>
              <td>
                <AvailabilityPill engine={e} />
                {e.availability.status === "unavailable" && <span className="reason">{e.availability.reason}</span>}
              </td>
              <td className="selectable">{e.license}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function OperationCard({ op, caps }: { op: OperationReport; caps: Capabilities }) {
  const noted = op.pairs.filter((p) => p.notes.length > 0);
  return (
    <Card title={op.label} action={op.available ? <span className="pill pill--ok">Available</span> : <span className="pill pill--bad">Unavailable</span>}>
      <p className="op-desc">{op.description}</p>
      {!op.available && <Callout tone="warning">{op.unavailable_reason}</Callout>}
      {op.pairs.length > 0 ? (
        <>
          <div className="matrix-wrap" tabIndex={0} role="region" aria-label={`${op.label} conversion table`}>
            <table className="plain-table matrix">
              <caption className="sr-only">{op.label}: which input formats can be turned into which output formats</caption>
              <thead>
                <tr>
                  <th scope="col">From \ To</th>
                  {op.outputs.map((o) => (
                    <th key={o} scope="col">{formatLabel(caps, o)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {op.inputs.map((i) => (
                  <tr key={i}>
                    <th scope="row">{formatLabel(caps, i)}</th>
                    {op.outputs.map((o) => {
                      const ok = op.pairs.some((p) => p.from === i && p.to === o);
                      return (
                        <td key={o} className={ok ? "yes" : "no"}>
                          {ok ? <Check size={16} aria-label="supported" /> : <Minus size={16} aria-label="not supported" />}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {noted.length > 0 && (
            <details className="notes">
              <summary>What changes in each conversion</summary>
              <ul>
                {noted.map((p) => (
                  <li key={`${p.from}-${p.to}`}>
                    <strong>
                      {formatLabel(caps, p.from)} → {formatLabel(caps, p.to)}:
                    </strong>{" "}
                    {p.notes.join(" ")}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      ) : op.interactive ? (
        <dl className="io">
          <dt>Opens</dt>
          <dd>{labels(caps, op.inputs)}</dd>
          <dt>Where</dt>
          <dd>In the editor, one document at a time (not a batch job)</dd>
        </dl>
      ) : (
        <dl className="io">
          {op.inputs.length > 0 && (
            <>
              <dt>Reads</dt>
              <dd>{labels(caps, op.inputs)}</dd>
            </>
          )}
          <dt>{op.outputs.length > 0 ? "Writes" : "Produces"}</dt>
          <dd>{op.outputs.length > 0 ? labels(caps, op.outputs) : "The files inside the archive"}</dd>
        </dl>
      )}
    </Card>
  );
}

function LimitsCard({ caps }: { caps: Capabilities }) {
  const l = caps.limits;
  const rows: [string, string][] = [
    ["Largest single file", l.max_file_bytes ? formatBytes(l.max_file_bytes) : "—"],
    ["Largest job", l.max_request_bytes ? formatBytes(l.max_request_bytes) : "—"],
    ["Files per job", l.max_files ? String(l.max_files) : "—"],
    ["Jobs running at once", l.max_concurrent_jobs ? String(l.max_concurrent_jobs) : "—"],
    ["Largest archive when extracted", formatBytes(l.default_max_extract_bytes)],
    ["Items in one archive", l.max_archive_entries.toLocaleString()],
    ["Largest image", `${l.max_image_dimension.toLocaleString()} px wide or tall`],
    ["Largest WebP image", `${l.max_webp_dimension.toLocaleString()} px wide or tall`],
    ["Widest PDF page preview", `${l.max_pdf_render_width.toLocaleString()} px`],
  ];
  return (
    <Card title="Limits">
      <dl className="io io--wide">
        {rows.map(([k, v]) => (
          <div key={k} className="io__row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
