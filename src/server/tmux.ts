import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";

export interface TmuxPane {
  socket: string;
  paneId: string;
  tty: string;
  session: string;
  windowIndex: string;
  paneIndex: string;
  sessionAttached: boolean;
}

export interface TmuxClient {
  socket: string;
  tty: string;
  session: string;
}

export interface TmuxSnapshot {
  byTty: Map<string, TmuxPane>;
  clients: TmuxClient[];
}

const PANE_FORMAT = "#{pane_id}|#{pane_tty}|#{window_index}|#{pane_index}|#{session_attached}|#{session_name}";
const CLIENT_FORMAT = "#{client_tty}|#{client_session}";

const SAFE_PANE_ID = /^%\d+$/;
const BARE_PATH = /^[A-Za-z0-9._/-]+$/;

function socketDir(): string {
  return process.env.TMUX_TMPDIR ?? `/tmp/tmux-${userInfo().uid}`;
}

function sockets(): string[] {
  try {
    return readdirSync(socketDir(), { withFileTypes: true })
      .filter((e) => e.isSocket())
      .map((e) => join(socketDir(), e.name));
  } catch {
    return [];
  }
}

// -S is always explicit: counter-intel may itself be running inside tmux, and an
// inherited $TMUX would otherwise silently pick the socket for us.
function tmux(socket: string, args: string[]): string | null {
  try {
    return execFileSync("tmux", ["-S", socket, ...args], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

// Session names are free text, so the fixed-shape fields come first and whatever
// remains after them is the name — splitting on every separator would corrupt a
// name containing one.
function splitFields(line: string, fixed: number): string[] | null {
  const parts = line.split("|");
  if (parts.length < fixed + 1) return null;
  return [...parts.slice(0, fixed), parts.slice(fixed).join("|")];
}

export function tmuxSnapshot(): TmuxSnapshot {
  const byTty = new Map<string, TmuxPane>();
  const clients: TmuxClient[] = [];

  for (const socket of sockets()) {
    for (const line of (tmux(socket, ["list-panes", "-a", "-F", PANE_FORMAT]) ?? "").split("\n")) {
      if (!line) continue;
      const fields = splitFields(line, 5);
      if (!fields) continue;
      const [paneId, tty, windowIndex, paneIndex, attached, session] = fields;
      if (!SAFE_PANE_ID.test(paneId) || !tty) continue;
      byTty.set(tty, {
        socket,
        paneId,
        tty,
        session,
        windowIndex,
        paneIndex,
        sessionAttached: attached === "1",
      });
    }

    for (const line of (tmux(socket, ["list-clients", "-F", CLIENT_FORMAT]) ?? "").split("\n")) {
      if (!line) continue;
      const fields = splitFields(line, 1);
      if (!fields) continue;
      const [tty, session] = fields;
      if (tty) clients.push({ socket, tty, session });
    }
  }

  return { byTty, clients };
}

export function paneLabel(pane: TmuxPane): string {
  return `${pane.session}:${pane.windowIndex}.${pane.paneIndex}`;
}

// The socket path comes from $TMUX_TMPDIR, which is free text, so it is quoted
// unless it needs no quoting — the pane id is the only other thing in the string
// and SAFE_PANE_ID already constrains it to `%N`.
function shellQuote(path: string): string {
  return BARE_PATH.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`;
}

/**
 * A pane id resolves to its own session, so the command carries no session name.
 * The socket stays explicit even when it is the default one: the shell that runs
 * this may resolve `$TMUX_TMPDIR` differently than the server did, and a short
 * command that finds the wrong server is worse than a long one that can't.
 */
export function attachCommand(pane: TmuxPane): string {
  return `tmux -S ${shellQuote(pane.socket)} attach -t ${pane.paneId}`;
}

/** Makes the pane current within its session. Works while the session is detached. */
export function selectPane(pane: TmuxPane): boolean {
  if (!SAFE_PANE_ID.test(pane.paneId)) return false;
  if (tmux(pane.socket, ["select-window", "-t", pane.paneId]) === null) return false;
  return tmux(pane.socket, ["select-pane", "-t", pane.paneId]) !== null;
}
