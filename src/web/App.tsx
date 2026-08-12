import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionDetail, SessionStatus, SessionSummary } from "../shared/types.js";
import { SessionCard } from "./SessionCard.js";
import { DetailPanel } from "./DetailPanel.js";
import { SupervisorPanel } from "./SupervisorPanel.js";

const STATUS_ORDER: SessionStatus[] = ["blocked", "waiting", "working", "idle", "ended"];

const STATUS_LABEL: Record<SessionStatus, string> = {
  blocked: "Needs you",
  waiting: "Waiting on you",
  working: "Working",
  idle: "Idle",
  ended: "Ended",
};

type Scope = "active" | "recent" | "all";

const SCOPE_LABEL: Record<Scope, string> = {
  active: "Active",
  recent: "Last 7 days",
  all: "Everything",
};

function withinDays(s: SessionSummary, days: number): boolean {
  if (!s.updatedAt) return false;
  return Date.now() - Date.parse(s.updatedAt) < days * 86_400_000;
}

function groupByStatus(list: SessionSummary[]): Array<readonly [SessionStatus, SessionSummary[]]> {
  const map = new Map<SessionStatus, SessionSummary[]>();
  for (const s of list) {
    const bucket = map.get(s.status) ?? [];
    bucket.push(s);
    map.set(s.status, bucket);
  }
  return STATUS_ORDER.filter((s) => map.has(s)).map((s) => [s, map.get(s) ?? []] as const);
}

export function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [scope, setScope] = useState<Scope>("recent");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [showSupervisor, setShowSupervisor] = useState(false);
  const [showPast, setShowPast] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const clearQuery = useCallback(() => {
    setQuery("");
    searchRef.current?.focus();
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSessions(data.sessions);
      setLoadedAt(data.generatedAt);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 4000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    const fetchDetail = async () => {
      try {
        const res = await fetch(`/api/sessions/${selected}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setDetail(data);
      } catch {
        /* transient */
      }
    };
    void fetchDetail();
    const id = setInterval(fetchDetail, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const matchesQuery = useCallback(
    (s: SessionSummary) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return [s.title, s.projectName, s.gitBranch, s.cwd, s.lastPrompt, ...s.refs.map((r) => r.value)]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    },
    [query],
  );

  const byRecency = (a: SessionSummary, b: SessionSummary) => {
    const byStatus = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
    if (byStatus !== 0) return byStatus;
    return Date.parse(b.updatedAt ?? "0") - Date.parse(a.updatedAt ?? "0");
  };

  // Live sessions are never hidden by the recency scope — that filter only makes
  // sense for history.
  const live = useMemo(
    () => sessions.filter((s) => s.isLive && matchesQuery(s)).sort(byRecency),
    [sessions, matchesQuery],
  );

  const past = useMemo(
    () =>
      sessions
        .filter((s) => {
          if (s.isLive) return false;
          if (scope === "active") return false;
          if (scope === "recent" && !withinDays(s, 7)) return false;
          return matchesQuery(s);
        })
        .sort(byRecency),
    [sessions, scope, matchesQuery],
  );

  // Pills summarize what is open right now; history counts would swamp them.
  const counts = useMemo(() => {
    const c: Partial<Record<SessionStatus, number>> = {};
    for (const s of sessions) if (s.isLive) c[s.status] = (c[s.status] ?? 0) + 1;
    return c;
  }, [sessions]);

  const liveGroups = useMemo(() => groupByStatus(live), [live]);
  const pastGroups = useMemo(() => groupByStatus(past), [past]);
  // A search that only matches history would otherwise look like zero results.
  const pastOpen = showPast || query.trim().length > 0;

  return (
    <div className={`app ${detail || showSupervisor ? "app-drawered" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" />
          <h1>counter-intel</h1>
        </div>

        <div className="pills">
          {STATUS_ORDER.map((s) =>
            counts[s] ? (
              <span key={s} className={`pill pill-${s}`}>
                <i /> {counts[s]} {STATUS_LABEL[s].toLowerCase()}
              </span>
            ) : null,
          )}
        </div>

        <div className="controls">
          <div className="search-wrap">
            <input
              ref={searchRef}
              className="search"
              placeholder="Filter by title, branch, path, PR…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Clear the field rather than letting Escape close an open drawer.
                if (e.key === "Escape" && query) {
                  e.stopPropagation();
                  clearQuery();
                }
              }}
            />
            {query && (
              <button className="search-clear" onClick={clearQuery} aria-label="Clear filter">
                ×
              </button>
            )}
          </div>
          <div className="segmented">
            {(Object.keys(SCOPE_LABEL) as Scope[]).map((s) => (
              <button key={s} className={scope === s ? "on" : ""} onClick={() => setScope(s)}>
                {SCOPE_LABEL[s]}
              </button>
            ))}
          </div>
          <button
            className={`sup-open ${showSupervisor ? "on" : ""}`}
            onClick={() => {
              setShowSupervisor((v) => !v);
              setSelected(null);
            }}
          >
            Supervisor
          </button>
        </div>
      </header>

      {error && <div className="banner error">API unreachable: {error}</div>}

      <main className="board">
        {live.length === 0 && past.length === 0 && !error && (
          <div className="empty">
            <p>No sessions match.</p>
            <span>Try widening the scope to “Everything”.</span>
          </div>
        )}

        {live.length === 0 && past.length > 0 && (
          <div className="empty empty-live">
            <p>No sessions open in a terminal right now.</p>
            <span>Past sessions are below.</span>
          </div>
        )}

        {liveGroups.map(([status, list]) => (
          <section key={status} className="group">
            <h2 className={`group-head status-${status}`}>
              <i /> {STATUS_LABEL[status]} <span className="count">{list.length}</span>
            </h2>
            <div className="cards">
              {list.map((s) => (
                <SessionCard
                  key={s.sessionId}
                  session={s}
                  active={s.sessionId === selected}
                  onClick={() => setSelected(s.sessionId === selected ? null : s.sessionId)}
                />
              ))}
            </div>
          </section>
        ))}

        {past.length > 0 && (
          <section className="past">
            <button
              className="past-toggle"
              onClick={() => setShowPast((v) => !v)}
              aria-expanded={pastOpen}
            >
              <span className={`chevron ${pastOpen ? "open" : ""}`}>▸</span>
              Not open in a terminal
              <span className="count">{past.length}</span>
              {!pastOpen && <span className="past-hint">click to review history</span>}
            </button>

            {pastOpen &&
              pastGroups.map(([status, list]) => (
                <div key={status} className="group">
                  <h2 className={`group-head status-${status}`}>
                    <i /> {STATUS_LABEL[status]} <span className="count">{list.length}</span>
                  </h2>
                  <div className="cards">
                    {list.map((s) => (
                      <SessionCard
                        key={s.sessionId}
                        session={s}
                        active={s.sessionId === selected}
                        onClick={() => setSelected(s.sessionId === selected ? null : s.sessionId)}
                      />
                    ))}
                  </div>
                </div>
              ))}
          </section>
        )}
      </main>

      <footer className="statusbar">
        <span>{sessions.length} sessions indexed</span>
        {loadedAt && <span>updated {new Date(loadedAt).toLocaleTimeString()}</span>}
      </footer>

      {detail && <DetailPanel detail={detail} onClose={() => setSelected(null)} />}
      {showSupervisor && (
        <SupervisorPanel
          onClose={() => setShowSupervisor(false)}
          onOpenSession={(id) => {
            setShowSupervisor(false);
            setSelected(id);
          }}
        />
      )}
    </div>
  );
}
