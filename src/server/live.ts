import { execFileSync } from "node:child_process";
import type { SessionProvider } from "../shared/types.js";

export interface LiveProc {
  provider: SessionProvider;
  /** Rollouts currently held open, including multiple threads in an app server. */
  sessionIds: string[];
  pid: number;
  ppid: number;
  tty: string | null;
  cwd: string | null;
  command: string;
}

// The CLI spawns helper processes that share the `claude` name but own no session.
const HELPER_MARKERS = [
  "--bg-pty-host",
  "bg-pty-host",
  "bg-spare",
  "--chrome-native-host",
  "daemon run",
  "mcp serve",
];

function run(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

function cwdsFor(pids: number[]): Map<number, string> {
  const out = new Map<number, string>();
  if (pids.length === 0) return out;
  const raw = run("lsof", ["-a", "-d", "cwd", "-p", pids.join(","), "-Fn"]);
  let current: number | null = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("p")) current = Number(line.slice(1));
    else if (line.startsWith("n") && current !== null) out.set(current, line.slice(1));
  }
  return out;
}

export function liveProcesses(): LiveProc[] {
  const raw = run("ps", ["-eo", "pid=,ppid=,tty=,command="]);
  const procs: LiveProc[] = [];

  for (const line of raw.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, pidStr, ppidStr, tty, command] = m;
    const provider = providerForCommand(command);
    if (!provider) continue;
    procs.push({
      provider,
      sessionIds: [],
      pid: Number(pidStr),
      ppid: Number(ppidStr),
      tty: tty === "??" ? null : tty,
      cwd: null,
      command: command.trim(),
    });
  }

  const cwds = cwdsFor(procs.map((p) => p.pid));
  for (const p of procs) p.cwd = cwds.get(p.pid) ?? null;
  // A launcher and its native child represent the same CLI. Keep the child so a
  // second historical session cannot claim the launcher's cwd as another tab.
  const native = procs.filter((p) => p.provider !== "codex" || !procs.some((child) => child.ppid === p.pid && child.provider === p.provider));
  const codex = native.filter((p) => p.provider === "codex");
  if (codex.length) {
    const ids = rolloutSessions(run("lsof", ["-a", "-p", codex.map((p) => p.pid).join(","), "-Fn"]));
    for (const p of codex) p.sessionIds = ids.get(p.pid) ?? [];
  }
  return native;
}

export function providerForCommand(command: string): SessionProvider | null {
  if (/(^|\/)claude(\s|$)/.test(command) || command.includes("/share/claude/versions/")) {
    return HELPER_MARKERS.some((marker) => command.includes(marker)) ? null : "claude";
  }
  const executable = /^(?:(?:\S*\/)?node\s+)?(?:\S*\/)?codex(?:\.js)?(?:\s|$)/.exec(command);
  if (!executable) return null;
  if (/^(?:mcp-server|mcp|login|logout|completion|app-server-health)(?:\s|$)/.test(command.slice(executable[0].length).trimStart())) return null;
  return "codex";
}

export function rolloutSessions(raw: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  let pid: number | null = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    if (pid === null || !line.startsWith("n")) continue;
    const id = /\/rollout-[^/]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(line)?.[1];
    if (id) out.set(pid, [...new Set([...(out.get(pid) ?? []), id])]);
  }
  return out;
}

export function explicitSessionId(command: string, provider: SessionProvider = "claude"): string | null {
  // Fork targets name the source session, not the newly running one.
  if (provider === "codex" && /\bfork\b/.test(command)) return null;
  const m = provider === "codex"
    ? /\bresume\s+(?:--[\w-]+\s+)*([0-9a-f-]{36})(?=\s|$)/i.exec(command)
    : /--session-id\s+([0-9a-f-]{36})/i.exec(command);
  return m?.[1] ?? null;
}
