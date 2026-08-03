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
`);

export function resetIncrementalCursors(): void {
  db.prepare("UPDATE sessions SET bytes_read = 0").run();
}
