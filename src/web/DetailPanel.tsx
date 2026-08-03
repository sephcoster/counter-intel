import { useState } from "react";
import type { SessionDetail } from "../shared/types.js";
import { compactTokens, linearUrl, prUrl, relativeTime, shortenPath } from "./format.js";

interface Props {
  detail: SessionDetail;
  onClose: () => void;
}

type Tab = "activity" | "files" | "events";

export function DetailPanel({ detail: d, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("activity");
  const resumeCmd = `cd ${d.cwd ?? "."} && claude --resume ${d.sessionId}`;

  return (
    <aside className="drawer">
      <div className="drawer-head">
        <div>
          <span className={`dot status-${d.status}`} />
          <h2>{d.title ?? d.firstPrompt ?? "(untitled session)"}</h2>
        </div>
        <button className="close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <div className="drawer-facts">
        <Fact label="Path" value={shortenPath(d.cwd)} mono />
        <Fact label="Branch" value={d.gitBranch ?? "—"} mono />
        <Fact label="Worktree" value={d.isWorktree ? (d.worktreeOf ? `of ${shortenPath(d.worktreeOf)}` : "yes") : "no"} />
        <Fact label="Model" value={d.model ?? "—"} />
        <Fact
          label="Context"
          value={`${compactTokens(d.contextTokens)} / ${compactTokens(d.contextWindow)} (${Math.round(d.contextPct)}%)`}
        />
        <Fact label="Messages" value={`${d.messageCount} (${d.userMessageCount} prompts)`} />
        <Fact label="Status" value={`${d.status} · via ${d.statusSource}`} />
        <Fact label="PID / TTY" value={d.pid ? `${d.pid}${d.tty ? ` · ${d.tty}` : ""}` : "not running"} />
        <Fact label="Started" value={relativeTime(d.createdAt)} />
        <Fact label="Last activity" value={relativeTime(d.updatedAt)} />
      </div>

      {d.refs.length > 0 && (
        <div className="drawer-refs">
          {d.refs.map((r) => (
            <a
              key={`${r.kind}:${r.value}`}
              className={`chip chip-${r.kind}`}
              href={r.kind === "pr" ? prUrl(r.value) : linearUrl(r.value)}
              target="_blank"
              rel="noreferrer"
            >
              {r.kind === "pr" ? "PR " : ""}
              {r.value}
            </a>
          ))}
        </div>
      )}

      <div className="resume">
        <code>{resumeCmd}</code>
        <button onClick={() => void navigator.clipboard.writeText(resumeCmd)}>Copy</button>
      </div>

      <nav className="tabs">
        {(["activity", "files", "events"] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t}
            {t === "files" && d.files.length > 0 && <span className="tab-count">{d.files.length}</span>}
          </button>
        ))}
      </nav>

      <div className="drawer-body">
        {tab === "activity" && (
          <div className="turns">
            {d.turns.length === 0 && <p className="muted">No recorded turns.</p>}
            {d.turns.map((t) => (
              <div key={t.uuid} className={`turn turn-${t.role}`}>
                <div className="turn-head">
                  <span>{t.role}</span>
                  <span className="muted">{relativeTime(t.ts)}</span>
                </div>
                <p>{t.text}</p>
              </div>
            ))}
          </div>
        )}

        {tab === "files" && (
          <ul className="files">
            {d.files.length === 0 && <p className="muted">No file operations recorded.</p>}
            {d.files.map((f) => (
              <li key={f.path}>
                <span className="mono">{shortenPath(f.path)}</span>
                <span className="muted">{f.count}×</span>
              </li>
            ))}
          </ul>
        )}

        {tab === "events" && (
          <ul className="events">
            {d.recentEvents.length === 0 && (
              <p className="muted">
                No hook events. Run <code>npm run install-hook</code> for live status on new sessions.
              </p>
            )}
            {d.recentEvents.map((e, i) => (
              <li key={`${e.ts}-${i}`}>
                <span className="mono">{e.event}</span>
                <span className="muted">{relativeTime(e.ts)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd className={mono ? "mono" : ""} title={value}>
        {value}
      </dd>
    </div>
  );
}
