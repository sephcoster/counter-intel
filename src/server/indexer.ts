import { openSync, readSync, closeSync, statSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { db } from "./db.js";
import { applyLine, emptyAccumulator, type Accumulator } from "./parse.js";
import { applyCodexLine } from "./codex.js";
import type { SessionProvider } from "../shared/types.js";

export const PROJECTS_DIR = process.env.COUNTER_INTEL_PROJECTS ?? join(homedir(), ".claude", "projects");
export const CODEX_SESSIONS_DIR = process.env.COUNTER_INTEL_CODEX_SESSIONS
  ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");

const CHUNK = 4 * 1024 * 1024;

interface Transcript {
  provider: SessionProvider;
  sessionId: string;
  path: string;
  projectDir: string;
  size: number;
  mtimeMs: number;
}

export function discoverTranscripts(): Transcript[] {
  const out: Transcript[] = [];
  for (const projectDir of existsSync(PROJECTS_DIR) ? readdirSync(PROJECTS_DIR) : []) {
    const dir = join(PROJECTS_DIR, projectDir);
    let entries: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const path = join(dir, entry);
      try {
        const st = statSync(path);
        if (!st.isFile()) continue;
        out.push({
          provider: "claude",
          sessionId: basename(entry, ".jsonl"),
          path,
          projectDir,
          size: st.size,
          mtimeMs: st.mtimeMs,
        });
      } catch {
        /* transcript vanished mid-scan */
      }
    }
  }
  discoverCodex(CODEX_SESSIONS_DIR, out);
  return out;
}

function discoverCodex(dir: string, out: Transcript[]): void {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      discoverCodex(path, out);
      continue;
    }
    const id = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(entry.name)?.[1];
    if (!entry.isFile() || !id) continue;
    try {
      const st = statSync(path);
      out.push({ provider: "codex", sessionId: id, path, projectDir: "codex", size: st.size, mtimeMs: st.mtimeMs });
    } catch { /* transcript vanished mid-scan */ }
  }
}

function rehydrate(row: Record<string, unknown>): Accumulator {
  const acc = emptyAccumulator();
  acc.sessionId = (row.session_id as string) ?? null;
  acc.cwd = (row.cwd as string) ?? null;
  acc.gitBranch = (row.git_branch as string) ?? null;
  acc.title = (row.title as string) ?? null;
  acc.firstPrompt = (row.first_prompt as string) ?? null;
  acc.lastPrompt = (row.last_prompt as string) ?? null;
  acc.mode = (row.mode as string) ?? null;
  acc.permissionMode = (row.permission_mode as string) ?? null;
  acc.model = (row.model as string) ?? null;
  acc.version = (row.version as string) ?? null;
  acc.messageCount = Number(row.message_count ?? 0);
  acc.userMessageCount = Number(row.user_message_count ?? 0);
  acc.createdAt = (row.created_at as string) ?? null;
  acc.updatedAt = (row.updated_at as string) ?? null;
  acc.contextTokens = Number(row.context_tokens ?? 0);
  acc.contextWindow = Number(row.context_window ?? 0);
  acc.transcriptStatus = row.transcript_status as Accumulator["transcriptStatus"] ?? null;
  acc.isSidechain = Number(row.is_sidechain ?? 0) === 1;
  acc.seq = acc.messageCount;
  if (typeof row.parser_state === "string") {
    const state = JSON.parse(row.parser_state);
    acc.seq = state.seq ?? acc.seq;
    acc.toolCalls = new Map(state.toolCalls ?? []);
  }
  return acc;
}

function readFrom(path: string, start: number, size: number, acc: Accumulator, provider: SessionProvider): number {
  if (start >= size) return start;
  const fd = openSync(path, "r");
  let pos = start;
  let leftover = Buffer.alloc(0);
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    while (pos < size) {
      const bytes = readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
      if (bytes <= 0) break;
      const data = Buffer.concat([leftover, buf.subarray(0, bytes)]);
      let lineStart = 0;
      let idx: number;
      while ((idx = data.indexOf(0x0a, lineStart)) !== -1) {
        const line = data.subarray(lineStart, idx).toString("utf8").trim();
        if (line) {
          if (provider === "codex") applyCodexLine(acc, line, pos - leftover.length + lineStart);
          else applyLine(acc, line);
        }
        lineStart = idx + 1;
      }
      leftover = data.subarray(lineStart);
      pos += bytes;
    }
  } finally {
    closeSync(fd);
  }
  // Leave any trailing partial line unconsumed so the next pass re-reads it whole.
  return pos - leftover.length;
}

const upsertSession = db.prepare(`
INSERT INTO sessions (
  session_id, transcript_path, project_dir, cwd, git_branch, title,
  first_prompt, last_prompt, mode, permission_mode, model, version,
  message_count, user_message_count, created_at, updated_at,
  context_tokens, is_sidechain, bytes_read, file_mtime, file_size,
  provider, context_window, transcript_status, parser_state
) VALUES (
  @session_id, @transcript_path, @project_dir, @cwd, @git_branch, @title,
  @first_prompt, @last_prompt, @mode, @permission_mode, @model, @version,
  @message_count, @user_message_count, @created_at, @updated_at,
  @context_tokens, @is_sidechain, @bytes_read, @file_mtime, @file_size,
  @provider, @context_window, @transcript_status, @parser_state
)
ON CONFLICT(session_id) DO UPDATE SET
  provider        = excluded.provider,
  context_window  = excluded.context_window,
  transcript_status = excluded.transcript_status,
  parser_state    = excluded.parser_state,
  transcript_path = excluded.transcript_path,
  project_dir     = excluded.project_dir,
  cwd             = COALESCE(excluded.cwd, sessions.cwd),
  git_branch      = COALESCE(excluded.git_branch, sessions.git_branch),
  title           = COALESCE(excluded.title, sessions.title),
  first_prompt    = COALESCE(sessions.first_prompt, excluded.first_prompt),
  last_prompt     = COALESCE(excluded.last_prompt, sessions.last_prompt),
  mode            = COALESCE(excluded.mode, sessions.mode),
  permission_mode = COALESCE(excluded.permission_mode, sessions.permission_mode),
  model           = COALESCE(excluded.model, sessions.model),
  version         = COALESCE(excluded.version, sessions.version),
  message_count      = excluded.message_count,
  user_message_count = excluded.user_message_count,
  created_at      = COALESCE(sessions.created_at, excluded.created_at),
  updated_at      = excluded.updated_at,
  context_tokens  = excluded.context_tokens,
  is_sidechain    = excluded.is_sidechain,
  bytes_read      = excluded.bytes_read,
  file_mtime      = excluded.file_mtime,
  file_size       = excluded.file_size
`);

// Incremental passes re-see the same ref from weaker sources, so the rank only ever
// narrows — a ref you named in a prompt must not decay to `tool` on the next append.
const upsertRef = db.prepare(`
INSERT INTO session_refs (session_id, kind, value, last_seen, source_rank)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(session_id, kind, value) DO UPDATE SET
  last_seen   = COALESCE(excluded.last_seen, session_refs.last_seen),
  source_rank = MIN(COALESCE(session_refs.source_rank, excluded.source_rank), excluded.source_rank)
`);

const upsertFile = db.prepare(`
INSERT INTO session_files (session_id, path, count, last_seen)
VALUES (?, ?, ?, ?)
ON CONFLICT(session_id, path) DO UPDATE SET
  count = session_files.count + excluded.count,
  last_seen = COALESCE(excluded.last_seen, session_files.last_seen)
`);

const upsertTurn = db.prepare(`
INSERT INTO turns (session_id, uuid, ts, seq, role, text)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(session_id, uuid) DO NOTHING
`);

const selectSession = db.prepare("SELECT * FROM sessions WHERE session_id = ?");

const clearDerived = db.transaction((sessionId: string) => {
  db.prepare("DELETE FROM session_refs WHERE session_id = ?").run(sessionId);
  db.prepare("DELETE FROM session_files WHERE session_id = ?").run(sessionId);
  db.prepare("DELETE FROM turns WHERE session_id = ?").run(sessionId);
  db.prepare("DELETE FROM transcript_events WHERE session_id = ?").run(sessionId);
});

const upsertEvent = db.prepare(`INSERT OR IGNORE INTO transcript_events (session_id, id, event, ts, cwd)
  VALUES (?, ?, ?, ?, ?)`);

const persist = db.transaction((t: Transcript, acc: Accumulator, bytesRead: number, fromScratch: boolean) => {
  if (fromScratch) {
    clearDerived(t.sessionId);
    db.prepare("DELETE FROM sessions WHERE session_id = ?").run(t.sessionId);
  }
  upsertSession.run({
    provider: t.provider,
    context_window: acc.contextWindow,
    transcript_status: acc.transcriptStatus,
    parser_state: JSON.stringify({ seq: acc.seq, toolCalls: [...acc.toolCalls] }),
    session_id: t.sessionId,
    transcript_path: t.path,
    project_dir: t.projectDir,
    cwd: acc.cwd,
    git_branch: acc.gitBranch,
    title: acc.title,
    first_prompt: acc.firstPrompt,
    last_prompt: acc.lastPrompt,
    mode: acc.mode,
    permission_mode: acc.permissionMode,
    model: acc.model,
    version: acc.version,
    message_count: acc.messageCount,
    user_message_count: acc.userMessageCount,
    created_at: acc.createdAt,
    updated_at: acc.updatedAt,
    context_tokens: acc.contextTokens,
    is_sidechain: acc.isSidechain ? 1 : 0,
    bytes_read: bytesRead,
    file_mtime: Math.floor(t.mtimeMs),
    file_size: t.size,
  });
  for (const ref of acc.refs.values()) {
    upsertRef.run(t.sessionId, ref.kind, ref.value, ref.lastSeen, ref.rank);
  }
  for (const [path, f] of acc.files) upsertFile.run(t.sessionId, path, f.count, f.lastSeen);
  let seq = acc.seq - acc.turns.length;
  for (const turn of acc.turns) upsertTurn.run(t.sessionId, turn.uuid, turn.ts, seq++, turn.role, turn.text);
  for (const event of acc.events) upsertEvent.run(t.sessionId, event.id, event.event, event.ts, event.cwd);
});

export interface IndexResult {
  scanned: number;
  updated: number;
  bytesRead: number;
  ms: number;
}

export function indexAll(force = false): IndexResult {
  const started = Date.now();
  const transcripts = discoverTranscripts();
  let updated = 0;
  let bytesRead = 0;

  for (const t of transcripts) {
    const row = selectSession.get(t.sessionId) as Record<string, unknown> | undefined;
    const priorBytes = force ? 0 : Number(row?.bytes_read ?? 0);
    const priorSize = Number(row?.file_size ?? 0);

    const unchanged = row && priorSize === t.size && Number(row.file_mtime) === Math.floor(t.mtimeMs);
    if (!force && unchanged && priorBytes >= t.size) continue;

    // A shrunk file means it was rewritten, not appended to — start over.
    const fromScratch = force || !row || t.size < priorSize || (t.size === priorSize && !unchanged);
    const acc = fromScratch ? emptyAccumulator() : rehydrate(row);
    const start = fromScratch ? 0 : priorBytes;

    let consumed: number;
    try {
      consumed = readFrom(t.path, start, t.size, acc, t.provider);
    } catch {
      continue;
    }

    bytesRead += consumed - start;
    persist(t, acc, consumed, fromScratch);
    updated += 1;
  }

  return { scanned: transcripts.length, updated, bytesRead, ms: Date.now() - started };
}
