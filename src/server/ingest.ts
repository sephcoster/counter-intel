import { openSync, readSync, closeSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { db } from "./db.js";

export const EVENT_LOG = process.env.COUNTER_INTEL_HOME
  ? join(process.env.COUNTER_INTEL_HOME, "events.jsonl")
  : join(homedir(), ".claude", "counter-intel", "events.jsonl");

const getState = db.prepare("SELECT value FROM ingest_state WHERE key = ?");
const setState = db.prepare(
  "INSERT INTO ingest_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
);
const insertEvent = db.prepare(
  "INSERT INTO hook_events (session_id, event, cwd, pid, tty, ts) VALUES (?, ?, ?, ?, ?, ?)",
);

const insertMany = db.transaction((rows: Array<Record<string, unknown>>) => {
  for (const r of rows) {
    const sessionId = String(r.session_id ?? "");
    const event = String(r.event ?? "");
    if (!sessionId || !event) continue;
    insertEvent.run(
      sessionId,
      event,
      r.cwd ? String(r.cwd) : null,
      Number(r.pid ?? 0) || null,
      r.tty ? String(r.tty) : null,
      String(r.ts ?? new Date().toISOString()),
    );
  }
});

export function ingestHookEvents(): number {
  if (!existsSync(EVENT_LOG)) return 0;

  const st = statSync(EVENT_LOG);
  const prior = Number((getState.get("event_log_offset") as { value?: string } | undefined)?.value ?? 0);
  // The hook rotates the log by truncation, so a shrunk file means start over.
  const start = st.size < prior ? 0 : prior;
  if (start >= st.size) return 0;

  const fd = openSync(EVENT_LOG, "r");
  let consumed = start;
  const rows: Array<Record<string, unknown>> = [];
  try {
    const len = st.size - start;
    const buf = Buffer.allocUnsafe(len);
    const bytes = readSync(fd, buf, 0, len, start);
    const data = buf.subarray(0, bytes);
    let lineStart = 0;
    let idx: number;
    while ((idx = data.indexOf(0x0a, lineStart)) !== -1) {
      const line = data.subarray(lineStart, idx).toString("utf8").trim();
      lineStart = idx + 1;
      if (!line) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        /* partially written line */
      }
    }
    consumed = start + lineStart;
  } finally {
    closeSync(fd);
  }

  insertMany(rows);
  setState.run("event_log_offset", String(consumed));

  db.prepare(
    "DELETE FROM hook_events WHERE id < (SELECT MAX(id) - 20000 FROM hook_events)",
  ).run();

  return rows.length;
}
