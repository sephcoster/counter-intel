import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { basename } from "node:path";
import { realpathSync } from "node:fs";
import { tmuxSnapshot, paneLabel, attachCommand, selectPane, type TmuxPane, type TmuxSnapshot } from "./tmux.js";

const run = promisify(execFile);

export type FocusFailure =
  | "no-tty"
  | "not-found"
  | "no-terminal"
  | "error"
  | "tmux-gone"
  | "tmux-other-session"
  | "tmux-client-unreachable";

export type FocusResult =
  | { ok: true; app: string; via: "tab" | "tmux" | "tmux-attach" | "app"; tmux?: string }
  | { ok: false; reason: FocusFailure; detail?: string; tmux?: string; attachCommand?: string };

// osascript takes the tty via argv rather than string interpolation so a hostile
// tty value can't break out into the script body.
const ITERM_SCRIPT = `on run argv
  set theTty to item 1 of argv
  if application "iTerm2" is not running then return "notrunning"
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (tty of s) is theTty then
            select s
            select t
            select w
            activate
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "notfound"
end run`;

const TERMINAL_SCRIPT = `on run argv
  set theTty to item 1 of argv
  if application "Terminal" is not running then return "notrunning"
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if (tty of t) is theTty then
          set selected tab of w to t
          set index of w to 1
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "notfound"
end run`;

const ITERM_ATTACH_SCRIPT = `on run argv
  set theCmd to item 1 of argv
  if application "iTerm2" is not running then return "notrunning"
  tell application "iTerm2"
    activate
    set newWindow to (create window with default profile)
    tell current session of newWindow to write text theCmd
  end tell
  return "ok"
end run`;

const TERMINAL_ATTACH_SCRIPT = `on run argv
  set theCmd to item 1 of argv
  if application "Terminal" is not running then return "notrunning"
  tell application "Terminal"
    activate
    do script theCmd
  end tell
  return "ok"
end run`;

export function normalizeTty(tty: string | null): string | null {
  if (!tty) return null;
  const trimmed = tty.trim();
  if (!trimmed || trimmed === "??" || trimmed === "-") return null;
  return trimmed.startsWith("/dev/") ? trimmed : `/dev/${trimmed}`;
}

async function tryScript(script: string, arg: string): Promise<string> {
  try {
    const { stdout } = await run("osascript", ["-e", script, arg], { timeout: 8000 });
    return stdout.trim();
  } catch (err) {
    return `error:${err instanceof Error ? err.message : String(err)}`;
  }
}

interface OwningApp {
  bundle: string;
  name: string;
}

const APP_BUNDLE = /^(\/.*\.app)\/Contents\/MacOS\//;

// `ps` reports the path as invoked, and neither `comm` nor `command` resolves symlinks —
// a Homebrew-cask terminal launched from the CLI shows up as `/opt/homebrew/bin/foo`,
// which hides the bundle it actually lives in.
function bundleFor(executable: string): string | null {
  const direct = APP_BUNDLE.exec(executable);
  if (direct) return direct[1];
  try {
    const resolved = APP_BUNDLE.exec(realpathSync(executable));
    return resolved ? resolved[1] : null;
  } catch {
    return null;
  }
}

/**
 * The application hosting a tty, found by walking the tty's process ancestry. Used
 * for terminals with no AppleScript dictionary — Alacritty, kitty, WezTerm, VS Code —
 * which the tty search above cannot see at all.
 *
 * Returns the *highest* .app ancestor: nested helper bundles (`Code Helper.app`) sit
 * below the real one, so the first match walking up is the wrong one. A tmux pane tty
 * has no such ancestor, which is correct — panes are resolved through tmux instead.
 */
function appForTty(tty: string): OwningApp | null {
  let table: string;
  try {
    table = execFileSync("ps", ["-eo", "pid=,ppid=,comm="], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }

  const parents = new Map<number, number>();
  const executables = new Map<number, string>();
  for (const line of table.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    parents.set(Number(m[1]), Number(m[2]));
    executables.set(Number(m[1]), m[3]);
  }

  let pid: number | null = null;
  try {
    const owner = execFileSync("ps", ["-t", tty, "-o", "pid="], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = owner.trim().split("\n")[0]?.trim();
    pid = first ? Number(first) : null;
  } catch {
    return null;
  }
  if (!pid || !Number.isFinite(pid)) return null;

  let found: OwningApp | null = null;
  for (let hops = 0; pid && pid > 1 && hops < 40; hops += 1) {
    const bundle = bundleFor(executables.get(pid) ?? "");
    if (bundle) found = { bundle, name: basename(bundle, ".app") };
    pid = parents.get(pid) ?? null;
  }
  return found;
}

// `open -a` needs no Automation grant, but it can only raise the application — an app
// with no scripting dictionary exposes no way to pick the window, so callers report
// this as a coarser jump than a tab focus.
async function activateApp(app: OwningApp): Promise<boolean> {
  try {
    await run("open", ["-a", app.bundle], { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

async function focusEmulatorTab(tty: string): Promise<FocusResult> {
  const iterm = await tryScript(ITERM_SCRIPT, tty);
  if (iterm === "ok") return { ok: true, app: "iTerm2", via: "tab" };

  const terminal = await tryScript(TERMINAL_SCRIPT, tty);
  if (terminal === "ok") return { ok: true, app: "Terminal", via: "tab" };

  const app = appForTty(tty);
  if (app && (await activateApp(app))) return { ok: true, app: app.name, via: "app" };

  if (iterm === "notrunning" && terminal === "notrunning") return { ok: false, reason: "no-terminal" };
  if (iterm.startsWith("error:")) return { ok: false, reason: "error", detail: iterm.slice(6) };
  if (terminal.startsWith("error:")) return { ok: false, reason: "error", detail: terminal.slice(6) };
  return { ok: false, reason: "not-found" };
}

async function attachInNewWindow(pane: TmuxPane): Promise<FocusResult> {
  const label = paneLabel(pane);
  const command = attachCommand(pane);

  const iterm = await tryScript(ITERM_ATTACH_SCRIPT, command);
  if (iterm === "ok") return { ok: true, app: "iTerm2", via: "tmux-attach", tmux: label };

  const terminal = await tryScript(TERMINAL_ATTACH_SCRIPT, command);
  if (terminal === "ok") return { ok: true, app: "Terminal", via: "tmux-attach", tmux: label };

  if (iterm === "notrunning" && terminal === "notrunning") {
    return { ok: false, reason: "no-terminal", tmux: label, attachCommand: command };
  }
  const failure = iterm.startsWith("error:") ? iterm : terminal;
  return {
    ok: false,
    reason: "error",
    detail: failure.startsWith("error:") ? failure.slice(6) : failure,
    tmux: label,
    attachCommand: command,
  };
}

async function focusTmuxPane(pane: TmuxPane, snapshot: TmuxSnapshot): Promise<FocusResult> {
  const label = paneLabel(pane);
  const command = attachCommand(pane);

  // Selecting first means an attach — or a manual window switch after a failed
  // raise — lands on the pane rather than wherever the session was left.
  if (!selectPane(pane)) {
    return { ok: false, reason: "tmux-gone", tmux: label, attachCommand: command };
  }

  const onServer = snapshot.clients.filter((c) => c.socket === pane.socket);
  const onSession = onServer.filter((c) => c.session === pane.session);

  for (const client of onSession) {
    const raised = await focusEmulatorTab(normalizeTty(client.tty) ?? client.tty);
    // An app-level raise is reported as such: the pane is selected, but the window
    // hosting the client was picked by the OS, not by us.
    if (raised.ok) {
      return { ok: true, app: raised.app, via: raised.via === "app" ? "app" : "tmux", tmux: label };
    }
  }

  if (onSession.length > 0) {
    const owners = onSession.map((c) => {
      const app = appForTty(normalizeTty(c.tty) ?? c.tty);
      return app ? `${c.tty} (${app.name})` : c.tty;
    });
    return {
      ok: false,
      reason: "tmux-client-unreachable",
      detail: `attached on ${owners.join(", ")}, which could not be raised`,
      tmux: label,
      attachCommand: command,
    };
  }

  // A terminal is already sitting on this tmux server, so spawning another window
  // would be window sprawl — and switching the one they have would yank their view.
  if (onServer.length > 0) {
    const elsewhere = [...new Set(onServer.map((c) => c.session))].join(", ");
    return {
      ok: false,
      reason: "tmux-other-session",
      detail: `your attached terminal is on ${elsewhere}`,
      tmux: label,
      attachCommand: command,
    };
  }

  return attachInNewWindow(pane);
}

export async function focusTty(rawTty: string | null): Promise<FocusResult> {
  const tty = normalizeTty(rawTty);
  if (!tty) return { ok: false, reason: "no-tty" };

  // Resolved at click time rather than trusted from the last poll — panes move.
  const snapshot = tmuxSnapshot();
  const pane = snapshot.byTty.get(tty);
  if (pane) return focusTmuxPane(pane, snapshot);

  return focusEmulatorTab(tty);
}

/** Explicit attach, for when focus reported a pane it declined to reach on its own. */
export async function attachTmuxPane(rawTty: string | null): Promise<FocusResult> {
  const tty = normalizeTty(rawTty);
  if (!tty) return { ok: false, reason: "no-tty" };

  const pane = tmuxSnapshot().byTty.get(tty);
  if (!pane) return { ok: false, reason: "tmux-gone" };
  // A pane that won't select is a pane that has gone, so there is nothing to attach to.
  if (!selectPane(pane)) {
    return { ok: false, reason: "tmux-gone", tmux: paneLabel(pane), attachCommand: attachCommand(pane) };
  }

  return attachInNewWindow(pane);
}
