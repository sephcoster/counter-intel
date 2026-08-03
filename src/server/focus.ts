import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export type FocusResult =
  | { ok: true; app: string }
  | { ok: false; reason: "no-tty" | "not-found" | "no-terminal" | "error"; detail?: string };

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

export function normalizeTty(tty: string | null): string | null {
  if (!tty) return null;
  const trimmed = tty.trim();
  if (!trimmed || trimmed === "??" || trimmed === "-") return null;
  return trimmed.startsWith("/dev/") ? trimmed : `/dev/${trimmed}`;
}

async function tryScript(script: string, tty: string): Promise<string> {
  try {
    const { stdout } = await run("osascript", ["-e", script, tty], { timeout: 8000 });
    return stdout.trim();
  } catch (err) {
    return `error:${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function focusTty(rawTty: string | null): Promise<FocusResult> {
  const tty = normalizeTty(rawTty);
  if (!tty) return { ok: false, reason: "no-tty" };

  const iterm = await tryScript(ITERM_SCRIPT, tty);
  if (iterm === "ok") return { ok: true, app: "iTerm2" };

  const terminal = await tryScript(TERMINAL_SCRIPT, tty);
  if (terminal === "ok") return { ok: true, app: "Terminal" };

  if (iterm === "notrunning" && terminal === "notrunning") return { ok: false, reason: "no-terminal" };
  if (iterm.startsWith("error:")) return { ok: false, reason: "error", detail: iterm.slice(6) };
  if (terminal.startsWith("error:")) return { ok: false, reason: "error", detail: terminal.slice(6) };
  return { ok: false, reason: "not-found" };
}
