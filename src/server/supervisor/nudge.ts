import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { db } from "../db.js";
import { getSession } from "../status.js";
import { normalizeTty } from "../focus.js";
import { tmuxSnapshot, paneLabel } from "../tmux.js";
import type { SupervisorConfig } from "./config.js";

const run = promisify(execFile);

export type NudgeOutcome =
  | "sent"
  | "dry-run"
  | "skipped-status"
  | "skipped-rate-limit"
  | "skipped-no-tty"
  | "skipped-tmux"
  | "skipped-busy"
  | "skipped-busy-unknown"
  | "not-found"
  | "no-terminal"
  | "failed";

export interface NudgeResult {
  outcome: NudgeOutcome;
  detail: string | null;
}

// The busy check and the write happen inside one AppleScript so nothing can
// change between them. `is processing` is read defensively: if iTerm doesn't
// expose it we report that explicitly rather than assuming the session is free.
const INJECT_SCRIPT = `on run argv
  set theTty to item 1 of argv
  set theText to item 2 of argv
  if application "iTerm2" is not running then return "no-terminal"
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (tty of s) is theTty then
            set busyKnown to false
            set isBusy to true
            try
              set isBusy to (is processing of s)
              set busyKnown to true
            end try
            if busyKnown is false then return "skipped-busy-unknown"
            if isBusy then return "skipped-busy"
            tell s to write text theText
            return "sent"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not-found"
end run`;

const recordNudge = db.prepare(
  `INSERT INTO nudges (session_id, finding_id, text, outcome, detail, session_status, tty, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);

const lastSent = db.prepare(
  "SELECT created_at FROM nudges WHERE session_id = ? AND outcome = 'sent' ORDER BY id DESC LIMIT 1",
);

function audit(
  sessionId: string,
  findingId: number | null,
  text: string,
  outcome: NudgeOutcome,
  detail: string | null,
  status: string | null,
  tty: string | null,
): NudgeResult {
  recordNudge.run(sessionId, findingId, text, outcome, detail, status, tty, new Date().toISOString());
  return { outcome, detail };
}

export async function sendNudge(
  sessionId: string,
  text: string,
  findingId: number | null,
  config: SupervisorConfig,
): Promise<NudgeResult> {
  // Re-read state at the moment of sending rather than trusting the scan.
  const session = getSession(sessionId);
  if (!session) return audit(sessionId, findingId, text, "not-found", "unknown session", null, null);

  if (!config.nudgeableStatuses.includes(session.status)) {
    return audit(
      sessionId, findingId, text, "skipped-status",
      `status was ${session.status}`, session.status, session.tty,
    );
  }

  const tty = normalizeTty(session.tty);
  if (!tty) {
    return audit(sessionId, findingId, text, "skipped-no-tty", null, session.status, null);
  }

  // The busy interlock is iTerm's `is processing`, read inside the same AppleScript
  // as the write. A tmux pane exposes nothing equivalent — `pane_current_command`
  // reads `node` whether Claude is idle, thinking, or sitting at a permission prompt
  // — so `send-keys` would be a write with no interlock at all, and a nudge landing
  // on a prompt would answer it. Nudging tmux panes stays off until there's a real
  // readiness signal to gate on.
  const pane = tmuxSnapshot().byTty.get(tty);
  if (pane) {
    return audit(
      sessionId, findingId, text, "skipped-tmux",
      `pane ${paneLabel(pane)} — no busy interlock available`, session.status, tty,
    );
  }

  const previous = lastSent.get(sessionId) as { created_at: string } | undefined;
  if (previous) {
    const hours = (Date.now() - Date.parse(previous.created_at)) / 3_600_000;
    if (hours < config.minNudgeIntervalHours) {
      return audit(
        sessionId, findingId, text, "skipped-rate-limit",
        `last nudge ${hours.toFixed(1)}h ago`, session.status, tty,
      );
    }
  }

  if (config.dryRun) {
    return audit(sessionId, findingId, text, "dry-run", "dryRun enabled", session.status, tty);
  }

  let outcome: NudgeOutcome = "failed";
  let detail: string | null = null;
  try {
    const { stdout } = await run("osascript", ["-e", INJECT_SCRIPT, tty, text], {
      timeout: 20_000,
      encoding: "utf8",
    });
    const code = stdout.trim();
    outcome = (["sent", "skipped-busy", "skipped-busy-unknown", "not-found", "no-terminal"] as const).includes(
      code as NudgeOutcome as never,
    )
      ? (code as NudgeOutcome)
      : "failed";
    if (outcome === "failed") detail = code.slice(0, 200);
  } catch (err) {
    detail = err instanceof Error ? err.message.slice(0, 200) : String(err);
  }

  return audit(sessionId, findingId, text, outcome, detail, session.status, tty);
}

export function recentNudges(limit = 50): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT n.id, n.session_id, n.text, n.outcome, n.detail, n.session_status, n.created_at,
              s.title, s.git_branch
       FROM nudges n LEFT JOIN sessions s ON s.session_id = n.session_id
       ORDER BY n.id DESC LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;
}
