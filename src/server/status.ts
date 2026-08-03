import { db } from "./db.js";
import { repoInfo, projectName } from "./git.js";
import { liveProcesses, explicitSessionId, type LiveProc } from "./live.js";
import { contextWindowFor } from "./parse.js";
import { normalizeTty } from "./focus.js";
import type { SessionDetail, SessionStatus, SessionSummary, SessionRef } from "../shared/types.js";

const WORKING_EVENTS = new Set([
  "UserPromptSubmit", "SessionStart", "SubagentStart", "PreCompact", "PostToolUseFailure",
]);
const BLOCKED_EVENTS = new Set(["Notification", "PermissionRequest"]);

const ACTIVE_MS = 90_000;
const HOOK_TRUST_MS = 30 * 60_000;

interface LatestEvent {
  session_id: string;
  event: string;
  pid: number | null;
  tty: string | null;
  ts: string;
}

function latestEvents(): Map<string, LatestEvent> {
  const rows = db
    .prepare(
      `SELECT h.session_id, h.event, h.pid, h.tty, h.ts
       FROM hook_events h
       JOIN (SELECT session_id, MAX(id) AS id FROM hook_events GROUP BY session_id) m
         ON m.id = h.id`,
    )
    .all() as LatestEvent[];
  return new Map(rows.map((r) => [r.session_id, r]));
}

function refsFor(sessionIds: string[]): Map<string, SessionRef[]> {
  const out = new Map<string, SessionRef[]>();
  if (sessionIds.length === 0) return out;
  const placeholders = sessionIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT session_id, kind, value FROM session_refs
       WHERE session_id IN (${placeholders}) ORDER BY kind, value`,
    )
    .all(...sessionIds) as Array<{ session_id: string; kind: string; value: string }>;
  for (const r of rows) {
    const list = out.get(r.session_id) ?? [];
    list.push({
      kind: r.kind as SessionRef["kind"],
      value: r.value,
      label: r.kind === "pr" ? `#${r.value.split("#")[1]}` : r.value,
    });
    out.set(r.session_id, list);
  }
  return out;
}

function matchProcess(
  row: Record<string, unknown>,
  event: LatestEvent | undefined,
  procs: LiveProc[],
  claimed: Set<number>,
): LiveProc | null {
  const explicit = procs.find((p) => explicitSessionId(p.command) === row.session_id);
  if (explicit) return explicit;

  if (event?.pid) {
    const byPid = procs.find((p) => p.pid === event.pid);
    if (byPid) return byPid;
  }

  const cwd = row.cwd as string | null;
  if (!cwd) return null;
  const candidates = procs.filter((p) => p.cwd === cwd && !claimed.has(p.pid));
  if (candidates.length === 0) return null;
  return candidates[0] ?? null;
}

function deriveStatus(
  row: Record<string, unknown>,
  event: LatestEvent | undefined,
  proc: LiveProc | null,
  now: number,
): { status: SessionStatus; source: SessionSummary["statusSource"] } {
  const mtime = Number(row.file_mtime ?? 0);
  const recentlyTouched = now - mtime < ACTIVE_MS;

  if (event) {
    const age = now - Date.parse(event.ts);
    if (event.event === "SessionEnd") return { status: "ended", source: "hook" };
    if (Number.isFinite(age) && age < HOOK_TRUST_MS) {
      if (BLOCKED_EVENTS.has(event.event)) return { status: "blocked", source: "hook" };
      if (event.event === "Stop") return { status: "waiting", source: "hook" };
      if (WORKING_EVENTS.has(event.event)) {
        return { status: recentlyTouched || proc ? "working" : "waiting", source: "hook" };
      }
    }
  }

  if (proc) return { status: recentlyTouched ? "working" : "waiting", source: "process" };
  return { status: "idle", source: "mtime" };
}

export function listSessions(includeSidechains = false): SessionSummary[] {
  const rows = db
    .prepare(
      `SELECT * FROM sessions
       ${includeSidechains ? "" : "WHERE is_sidechain = 0"}
       ORDER BY file_mtime DESC`,
    )
    .all() as Array<Record<string, unknown>>;

  const events = latestEvents();
  const procs = liveProcesses();
  const claimed = new Set<number>();
  const refs = refsFor(rows.map((r) => String(r.session_id)));
  const now = Date.now();

  return rows.map((row) => {
    const sessionId = String(row.session_id);
    const event = events.get(sessionId);
    const proc = matchProcess(row, event, procs, claimed);
    if (proc) claimed.add(proc.pid);

    const { status, source } = deriveStatus(row, event, proc, now);
    const cwd = (row.cwd as string | null) ?? null;
    const info = repoInfo(cwd);
    const contextTokens = Number(row.context_tokens ?? 0);
    const model = (row.model as string | null) ?? null;
    const tty = normalizeTty(proc?.tty ?? event?.tty ?? null);
    const contextWindow = contextWindowFor(model, contextTokens);

    return {
      sessionId,
      title: (row.title as string | null) ?? null,
      cwd,
      projectName: projectName(cwd, String(row.project_dir)),
      gitBranch: (row.git_branch as string | null) ?? null,
      isWorktree: info.isWorktree,
      worktreeOf: info.worktreeOf,
      status,
      statusSource: source,
      pid: proc?.pid ?? event?.pid ?? null,
      tty,
      // A dead session's tab may still be open, so focusing is offered whenever we
      // know a tty — the AppleScript lookup is what actually decides.
      canFocus: tty !== null,
      model,
      contextTokens,
      contextWindow,
      contextPct: contextWindow > 0 ? Math.min(100, (contextTokens / contextWindow) * 100) : 0,
      messageCount: Number(row.message_count ?? 0),
      userMessageCount: Number(row.user_message_count ?? 0),
      createdAt: (row.created_at as string | null) ?? null,
      updatedAt: (row.updated_at as string | null) ?? null,
      lastPrompt: (row.last_prompt as string | null) ?? null,
      firstPrompt: (row.first_prompt as string | null) ?? null,
      permissionMode: (row.permission_mode as string | null) ?? null,
      isSidechain: Number(row.is_sidechain ?? 0) === 1,
      refs: refs.get(sessionId) ?? [],
      transcriptPath: String(row.transcript_path),
      sizeBytes: Number(row.file_size ?? 0),
    };
  });
}

export function getSession(sessionId: string): SessionDetail | null {
  const summary = listSessions(true).find((s) => s.sessionId === sessionId);
  if (!summary) return null;

  // One prompt can spawn dozens of assistant turns, so a plain tail buries the prompts —
  // which are the part worth reading when re-orienting. Pull them in on their own.
  const turns = db
    .prepare(
      `SELECT uuid, ts, role, text, seq FROM (
         SELECT * FROM (
           SELECT uuid, ts, role, text, seq FROM turns WHERE session_id = @id ORDER BY seq DESC LIMIT 40
         )
         UNION
         SELECT * FROM (
           SELECT uuid, ts, role, text, seq FROM turns WHERE session_id = @id AND role = 'user' ORDER BY seq DESC LIMIT 20
         )
       ) ORDER BY seq DESC`,
    )
    .all({ id: sessionId }) as Array<SessionDetail["turns"][number] & { seq: number }>;

  const files = db
    .prepare(
      "SELECT path, count, last_seen AS lastSeen FROM session_files WHERE session_id = ? ORDER BY count DESC LIMIT 40",
    )
    .all(sessionId) as SessionDetail["files"];

  const recentEvents = db
    .prepare("SELECT event, ts, cwd FROM hook_events WHERE session_id = ? ORDER BY id DESC LIMIT 25")
    .all(sessionId) as SessionDetail["recentEvents"];

  return { ...summary, turns: turns.reverse(), files, recentEvents };
}
