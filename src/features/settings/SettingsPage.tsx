import { useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Dialog } from "../../components/Dialog";
import { Field } from "../../components/Fields";
import { OutputFolder } from "../../components/OutputFolder";
import { PageHeader } from "../../components/PageHeader";
import { useCapabilities } from "../../app/CapabilitiesProvider";
import { useJobs } from "../../app/JobsProvider";
import { useNav } from "../../app/NavProvider";
import { AvailabilityPill } from "../formats/FormatsPage";
import { useSettings } from "../../app/SettingsProvider";
import { useToast } from "../../app/ToastProvider";
import { appVersion } from "../../services/appService";
import { jobsService } from "../../services/jobsService";
import type { ApiStatus } from "../../lib/types";
import { isActive } from "../../lib/types";
import type { HistoryRetention } from "../../services/settingsService";
import "./SettingsPage.css";

const RETENTION: { value: HistoryRetention; label: string }[] = [
  { value: "off", label: "Don't keep history" },
  { value: "7", label: "Keep for 7 days" },
  { value: "30", label: "Keep for 30 days" },
  { value: "90", label: "Keep for 90 days" },
  { value: "forever", label: "Keep until I clear it" },
];

export function SettingsPage() {
  const { settings, update } = useSettings();
  const { jobs, clearFinished } = useJobs();
  const { caps, state: capState } = useCapabilities();
  const { go } = useNav();
  const { push } = useToast();
  const [version, setVersion] = useState<string | null>(null);
  const [api, setApi] = useState<ApiStatus | "checking">("checking");
  const [confirm, setConfirm] = useState(false);
  const finished = jobs.filter((j) => !isActive(j)).length;

  useEffect(() => {
    void appVersion().then(setVersion);
    jobsService.apiStatus().then(setApi).catch(() => setApi({ connected: false, version: null }));
  }, []);

  return (
    <>
      <PageHeader title="Settings" subtitle="Preferences for this computer." />
      <Card title="Saving files">
        <OutputFolder label="Default save location" value={settings.defaultOutputDir} onChange={(dir) => update({ defaultOutputDir: dir })} />
        <p className="field__hint settings-note">Used when you start a job. You can still pick a different folder each time.</p>
      </Card>
      <Card title="History">
        <div className="options-grid">
          <Field label="Job history" htmlFor="retention" hint="Only file names, sizes and results are stored, on this computer. Never file contents or passwords.">
            <select id="retention" className="input select" value={settings.historyRetention} onChange={(e) => update({ historyRetention: e.target.value as HistoryRetention })}>
              {RETENTION.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>
          <div>
            <Button onClick={() => setConfirm(true)} disabled={finished === 0}>
              Clear history now
            </Button>
          </div>
        </div>
      </Card>
      <Card title="Engines">
        {capState.status === "loading" && <p className="field__hint">Checking installed engines…</p>}
        {capState.status === "error" && <p className="field__hint">Couldn't read the engine list: {capState.message}</p>}
        {caps && (
          <ul className="engine-list">
            {caps.engines.map((e) => (
              <li key={e.id}>
                <div>
                  <strong>{e.name}</strong>
                  <span className="selectable">{e.version}</span>
                  {e.availability.status === "unavailable" && <span className="reason">{e.availability.reason}</span>}
                </div>
                <AvailabilityPill engine={e} />
              </li>
            ))}
          </ul>
        )}
        <div className="settings-links">
          <Button size="sm" onClick={() => go("formats")}>
            Supported formats
          </Button>
          <Button size="sm" onClick={() => go("notices")}>
            Third-party notices
          </Button>
        </div>
      </Card>
      <Card title="About">
        <dl className="about">
          <dt>OrangeFile version</dt>
          <dd>{version ?? "Not available in the browser"}</dd>
          <dt>Processing service</dt>
          <dd>
            {api === "checking" ? (
              "Checking…"
            ) : api.connected ? (
              <span className="dot dot--ok">Running on this computer{api.version ? ` (v${api.version})` : ""}</span>
            ) : (
              <span className="dot dot--bad">Not running</span>
            )}
          </dd>
          <dt>Your files</dt>
          <dd>Processed on this computer. Nothing is uploaded to the internet.</dd>
        </dl>
      </Card>
      <Dialog
        open={confirm}
        title="Clear job history?"
        description="This removes the list of past jobs from this computer. The files you created are not touched."
        onClose={() => setConfirm(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setConfirm(false);
                void clearFinished().then(() => push("success", "History cleared."));
              }}
            >
              Clear history
            </Button>
          </>
        }
      >
        <p style={{ fontSize: 14 }}>{finished} finished job(s) will be removed.</p>
      </Dialog>
    </>
  );
}
