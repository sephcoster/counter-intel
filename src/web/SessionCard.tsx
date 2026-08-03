import type { SessionSummary } from "../shared/types.js";
import { compactTokens, relativeTime, shortenPath } from "./format.js";

interface Props {
  session: SessionSummary;
  active: boolean;
  onClick: () => void;
}

function contextTone(pct: number): string {
  if (pct >= 85) return "danger";
  if (pct >= 65) return "warn";
  return "ok";
}

export function SessionCard({ session: s, active, onClick }: Props) {
  const title = s.title ?? s.firstPrompt ?? "(untitled session)";
  const tone = contextTone(s.contextPct);

  return (
    <button className={`card ${active ? "card-active" : ""}`} onClick={onClick}>
      <div className="card-top">
        <span className={`dot status-${s.status}`} />
        <h3 title={title}>{title}</h3>
      </div>

      <div className="card-meta">
        <span className="project" title={s.cwd ?? ""}>
          {s.projectName}
        </span>
        {s.gitBranch && <span className="branch">{s.gitBranch}</span>}
        {s.isWorktree && <span className="badge worktree">worktree</span>}
        {s.permissionMode && s.permissionMode !== "default" && (
          <span className="badge mode">{s.permissionMode}</span>
        )}
      </div>

      <div className="path">{shortenPath(s.cwd)}</div>

      {s.lastPrompt && <p className="last-prompt">{s.lastPrompt}</p>}

      {s.refs.length > 0 && (
        <div className="refs">
          {s.refs.slice(0, 5).map((r) => (
            <span key={`${r.kind}:${r.value}`} className={`chip chip-${r.kind}`}>
              {r.kind === "pr" ? "PR " : ""}
              {r.label}
            </span>
          ))}
          {s.refs.length > 5 && <span className="chip chip-more">+{s.refs.length - 5}</span>}
        </div>
      )}

      <div className="card-foot">
        <div className={`gauge gauge-${tone}`} title={`${compactTokens(s.contextTokens)} of ${compactTokens(s.contextWindow)}`}>
          <div className="gauge-fill" style={{ width: `${Math.min(100, s.contextPct)}%` }} />
          <span className="gauge-label">
            {Math.round(s.contextPct)}% ctx · {compactTokens(s.contextTokens)}
          </span>
        </div>
        <span className="when">{relativeTime(s.updatedAt)}</span>
      </div>
    </button>
  );
}
