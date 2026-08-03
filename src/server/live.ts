import { execFileSync } from "node:child_process";

export interface LiveProc {
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
    if (!/(^|\/)claude(\s|$)/.test(command) && !command.includes("/share/claude/versions/")) continue;
    if (HELPER_MARKERS.some((marker) => command.includes(marker))) continue;
    procs.push({
      pid: Number(pidStr),
      ppid: Number(ppidStr),
      tty: tty === "??" ? null : tty,
      cwd: null,
      command: command.trim(),
    });
  }

  const cwds = cwdsFor(procs.map((p) => p.pid));
  for (const p of procs) p.cwd = cwds.get(p.pid) ?? null;
  return procs;
}

export function explicitSessionId(command: string): string | null {
  const m = /--session-id\s+([0-9a-f-]{36})/.exec(command);
  return m?.[1] ?? null;
}
