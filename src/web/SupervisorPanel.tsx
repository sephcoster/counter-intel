import { useCallback, useEffect, useState } from "react";
import { relativeTime } from "./format.js";

interface Signal {
  key: string;
  severity: string;
  summary: string;
}

interface Verdict {
  stuck: boolean;
  reason: string;
  template: string | null;
  confidence: string;
}

interface Finding {
  sessionId: string;
  title: string | null;
  branch: string | null;
  projectName: string;
  status: string;
  signals: Signal[];
  verdict: Verdict | null;
  createdAt: string;
}

interface Nudge {
  id: number;
  session_id: string;
  text: string;
  outcome: string;
  detail: string | null;
  session_status: string | null;
  created_at: string;
  title: string | null;
}

interface Config {
  enabled: boolean;
  dryRun: boolean;
  intervalMinutes: number;
  coreHours: { start: string; end: string; days: number[]; timezone: string };
  maxNudgesPerRun: number;
  minNudgeIntervalHours: number;
  model: string;
}

interface Payload {
  config: Config;
  findings: Finding[];
  nudges: Nudge[];
}

const OUTCOME_TONE: Record<string, string> = {
  sent: "ok",
  "dry-run": "dry",
  "skipped-status": "skip",
  "skipped-rate-limit": "skip",
  "skipped-busy": "skip",
  "skipped-busy-unknown": "skip",
  "skipped-no-tty": "skip",
  failed: "bad",
  "not-found": "bad",
  "no-terminal": "bad",
};

export function SupervisorPanel({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/supervisor");
      if (res.ok) setData(await res.json());
    } catch {
      /* transient */
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 8000);
    return () => clearInterval(id);
  }, [load]);

  const patch = async (body: Partial<Config>) => {
    setBusy(true);
    try {
      await fetch("/api/supervisor/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const scanNow = async () => {
    setBusy(true);
    setNote("Scanning…");
    try {
      const res = await fetch("/api/supervisor/run?force=1", { method: "POST" });
      const result = await res.json();
      setNote(
        result.ran
          ? `Scanned ${result.sessionsScanned} sessions · ${result.signalsFound} flagged · ` +
            `${result.triageCalls} triage call${result.triageCalls === 1 ? "" : "s"} · ` +
            `$${(result.costUsd ?? 0).toFixed(3)} · ${result.ms}ms`
          : `Skipped: ${result.skippedReason}`,
      );
      await load();
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!data) return null;
  const { config, findings, nudges } = data;

  return (
    <aside className="drawer supervisor">
      <div className="drawer-head">
        <div>
          <span className={`dot ${config.enabled ? "status-working" : "status-idle"}`} />
          <h2>Supervisor</h2>
        </div>
        <button className="close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <div className="sup-controls">
        <label className="toggle">
          <input
            type="checkbox"
            checked={config.enabled}
            disabled={busy}
            onChange={(e) => void patch({ enabled: e.target.checked })}
          />
          <span>Enabled</span>
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={config.dryRun}
            disabled={busy}
            onChange={(e) => void patch({ dryRun: e.target.checked })}
          />
          <span>Dry run</span>
        </label>
        <button disabled={busy} onClick={() => void scanNow()}>
          Scan now
        </button>
      </div>

      {!config.dryRun && (
        <div className="sup-warning">
          Live mode — nudges are typed into sessions reporting <code>waiting</code>.
        </div>
      )}

      <div className="sup-meta">
        every {config.intervalMinutes}m · {config.coreHours.start}–{config.coreHours.end}{" "}
        {config.coreHours.timezone} · max {config.maxNudgesPerRun}/run · {config.model}
      </div>

      {note && <div className="sup-note">{note}</div>}

      <div className="drawer-body">
        <h3 className="sup-heading">Stuck ({findings.length})</h3>
        {findings.length === 0 && <p className="muted">Nothing flagged.</p>}
        {findings.map((f) => (
          <div key={f.sessionId} className="finding">
            <div className="finding-head">
              <span className={`dot status-${f.status}`} />
              <strong>{f.title ?? "(untitled)"}</strong>
            </div>
            <div className="finding-sub">
              {f.projectName}
              {f.branch && <span className="branch">{f.branch}</span>}
            </div>
            <ul className="finding-signals">
              {f.signals.map((s) => (
                <li key={s.key} className={`sev-${s.severity}`}>
                  {s.summary}
                </li>
              ))}
            </ul>
            {f.verdict && (
              <div className={`verdict ${f.verdict.stuck ? "verdict-stuck" : "verdict-ok"}`}>
                <span>{f.verdict.stuck ? "STUCK" : "not stuck"}</span> · {f.verdict.reason}
                {f.verdict.template && <code>{f.verdict.template}</code>}
              </div>
            )}
            {!f.verdict && <div className="muted small">Awaiting triage — run a scan.</div>}
          </div>
        ))}

        <h3 className="sup-heading">Nudge log</h3>
        {nudges.length === 0 && <p className="muted">No nudges yet.</p>}
        <ul className="nudge-log">
          {nudges.map((n) => (
            <li key={n.id}>
              <div className="nudge-top">
                <span className={`outcome outcome-${OUTCOME_TONE[n.outcome] ?? "skip"}`}>
                  {n.outcome}
                </span>
                <span className="muted">{relativeTime(n.created_at)}</span>
              </div>
              <div className="nudge-text">{n.text}</div>
              {n.detail && <div className="muted small">{n.detail}</div>}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
