import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const DB_PATH = resolve(
  process.env.COUNTER_INTEL_DB ?? new URL("../../data/counter-intel.db", import.meta.url).pathname,
);

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  session_id           TEXT PRIMARY KEY,
  transcript_path      TEXT NOT NULL,
  project_dir          TEXT NOT NULL,
  cwd                  TEXT,
  git_branch           TEXT,
  title                TEXT,
  first_prompt         TEXT,
  last_prompt          TEXT,
  mode                 TEXT,
  permission_mode      TEXT,
  model                TEXT,
  version              TEXT,
  message_count        INTEGER NOT NULL DEFAULT 0,
  user_message_count   INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT,
  updated_at           TEXT,
  context_tokens       INTEGER NOT NULL DEFAULT 0,
  is_sidechain         INTEGER NOT NULL DEFAULT 0,
  bytes_read           INTEGER NOT NULL DEFAULT 0,
  file_mtime           INTEGER NOT NULL DEFAULT 0,
  file_size            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS session_refs (
  session_id TEXT NOT NULL,
  kind       TEXT NOT NULL,
  value      TEXT NOT NULL,
  last_seen  TEXT,
  PRIMARY KEY (session_id, kind, value)
);

CREATE TABLE IF NOT EXISTS session_files (
  session_id TEXT NOT NULL,
  path       TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  last_seen  TEXT,
  PRIMARY KEY (session_id, path)
);

CREATE TABLE IF NOT EXISTS turns (
  session_id TEXT NOT NULL,
  uuid       TEXT NOT NULL,
  ts         TEXT,
  seq        INTEGER NOT NULL,
  role       TEXT NOT NULL,
  text       TEXT NOT NULL,
  PRIMARY KEY (session_id, uuid)
);

CREATE INDEX IF NOT EXISTS turns_by_session ON turns (session_id, seq DESC);

CREATE TABLE IF NOT EXISTS hook_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event      TEXT NOT NULL,
  cwd        TEXT,
  pid        INTEGER,
  tty        TEXT,
  ts         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS hook_events_by_session ON hook_events (session_id, id DESC);

CREATE TABLE IF NOT EXISTS ingest_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS findings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  signals     TEXT NOT NULL,
  verdict     TEXT,
  created_at  TEXT NOT NULL,
  cleared_at  TEXT
);

CREATE INDEX IF NOT EXISTS findings_open ON findings (session_id, cleared_at);

CREATE TABLE IF NOT EXISTS nudges (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id     TEXT NOT NULL,
  finding_id     INTEGER,
  text           TEXT NOT NULL,
  outcome        TEXT NOT NULL,
  detail         TEXT,
  session_status TEXT,
  tty            TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS nudges_by_session ON nudges (session_id, id DESC);

CREATE TABLE IF NOT EXISTS supervisor_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  sessions_scanned INTEGER NOT NULL DEFAULT 0,
  signals_found   INTEGER NOT NULL DEFAULT 0,
  triage_calls    INTEGER NOT NULL DEFAULT 0,
  nudges_sent     INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL NOT NULL DEFAULT 0,
  skipped_reason  TEXT,
  error           TEXT
);
`);

function addColumn(table: string, column: string, definition: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

addColumn("findings", "nudge_text", "TEXT");
addColumn("findings", "dismissed_at", "TEXT");

/**
 * Where a ref came from can't be recovered from rows already stored, so gaining the column
 * means the transcripts have to be re-read once. The server checks this on boot.
 */
export const refsNeedReindex = addColumn("session_refs", "source_rank", "INTEGER");

export function resetIncrementalCursors(): void {
  db.prepare("UPDATE sessions SET bytes_read = 0").run();
}
