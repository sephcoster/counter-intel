import { db } from "../db.js";
import { listSessions } from "../status.js";
import { detect } from "./signals.js";
import { verdictFor, clearFindingsFor, type Verdict } from "./triage.js";
import { sendNudge, type NudgeOutcome } from "./nudge.js";
import { renderNudge, type NudgeContext } from "./templates.js";
import { loadSupervisorConfig, withinCoreHours, type SupervisorConfig } from "./config.js";

export interface RunSummary {
  ran: boolean;
  skippedReason?: string;
  sessionsScanned: number;
  signalsFound: number;
  triageCalls: number;
  nudges: Array<{ sessionId: string; title: string | null; text: string; outcome: NudgeOutcome }>;
  costUsd: number;
  ms: number;
}

const startRun = db.prepare("INSERT INTO supervisor_runs (started_at) VALUES (?)");
const finishRun = db.prepare(
  `UPDATE supervisor_runs SET finished_at = ?, sessions_scanned = ?, signals_found = ?,
     triage_calls = ?, nudges_sent = ?, cost_usd = ?, skipped_reason = ?, error = ?
   WHERE id = ?`,
);

let running = false;

export async function runOnce(options: { force?: boolean } = {}): Promise<RunSummary> {
  const config = loadSupervisorConfig();
  const started = Date.now();
  const empty: RunSummary = {
    ran: false, sessionsScanned: 0, signalsFound: 0, triageCalls: 0,
    nudges: [], costUsd: 0, ms: 0,
  };

  if (running) return { ...empty, skippedReason: "already running" };
  if (!options.force) {
    if (!config.enabled) return { ...empty, skippedReason: "supervisor disabled" };
    if (!withinCoreHours(config)) return { ...empty, skippedReason: "outside core hours" };
  }

  running = true;
  const runId = Number(startRun.run(new Date().toISOString()).lastInsertRowid);

  let triageCalls = 0;
  let costUsd = 0;
  const nudges: RunSummary["nudges"] = [];
  let error: string | null = null;
  let findings: Awaited<ReturnType<typeof detect>> = [];
  const sessions = listSessions();

  try {
    findings = await detect(sessions, config);

    // Anything that previously had signals but no longer does is resolved.
    const stillFlagged = new Set(findings.map((f) => f.session.sessionId));
    for (const s of sessions) {
      if (!stillFlagged.has(s.sessionId)) clearFindingsFor(s.sessionId);
    }

    const ordered = [...findings].sort(
      (a, b) => severityScore(b) - severityScore(a),
    );

    for (const finding of ordered) {
      const { result, costUsd: cost } = await verdictFor(finding, config);
      costUsd += cost;
      if (cost > 0) triageCalls += 1;
      if (!result?.verdict.stuck || !result.verdict.template) continue;
      if (nudges.length >= config.maxNudgesPerRun) break;

      const text = renderNudge(result.verdict.template, contextFor(finding));
      if (!text) continue;

      const outcome = await sendNudge(
        finding.session.sessionId,
        text,
        result.findingId,
        config,
      );
      nudges.push({
        sessionId: finding.session.sessionId,
        title: finding.session.title,
        text,
        outcome: outcome.outcome,
      });
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    running = false;
  }

  const sent = nudges.filter((n) => n.outcome === "sent").length;
  finishRun.run(
    new Date().toISOString(), sessions.length, findings.length,
    triageCalls, sent, costUsd, null, error, runId,
  );

  return {
    ran: true,
    sessionsScanned: sessions.length,
    signalsFound: findings.length,
    triageCalls,
    nudges,
    costUsd,
    ms: Date.now() - started,
    ...(error ? { skippedReason: `error: ${error}` } : {}),
  };
}

/** Every value here comes from git or gh, never from the transcript or the model. */
function contextFor(f: Awaited<ReturnType<typeof detect>>[number]): NudgeContext {
  const numberFrom = (prefix: string): number => {
    const hit = f.signals.find((s) => s.key.startsWith(prefix));
    return hit ? Number(hit.key.split(":")[1]) || 0 : 0;
  };
  const idleSignal = f.signals.find((s) => s.key.startsWith("idle-mid-task:"));
  return {
    branch: f.session.gitBranch,
    prNumber: f.pr?.number ?? null,
    unpushedCommits: numberFrom("unpushed-commits:"),
    branchCommits: f.pr ? 0 : numberFrom("branch-commits:") || commitsFromSummary(f),
    failedChecks: f.pr?.failedChecks ?? 0,
    unresolvedThreads: numberFrom("pr-unresolved-threads:"),
    idleHours: idleSignal ? Number(idleSignal.key.split(":")[1]?.replace("h", "")) || 0 : 0,
  };
}

function commitsFromSummary(f: Awaited<ReturnType<typeof detect>>[number]): number {
  const hit = f.signals.find((s) => s.key === "branch-no-pr");
  if (!hit) return 0;
  const match = /with (\d+) commit/.exec(hit.summary);
  return match ? Number(match[1]) : 0;
}

function severityScore(f: Awaited<ReturnType<typeof detect>>[number]): number {
  return f.signals.reduce(
    (acc, s) => acc + (s.severity === "high" ? 3 : s.severity === "medium" ? 2 : 1),
    0,
  );
}

export interface StuckEntry {
  sessionId: string;
  title: string | null;
  branch: string | null;
  projectName: string;
  status: string;
  signals: Array<{ key: string; severity: string; summary: string }>;
  verdict: Verdict | null;
  createdAt: string;
}

export function openFindings(): StuckEntry[] {
  const rows = db
    .prepare(
      `SELECT f.session_id, f.signals, f.verdict, f.created_at,
              s.title, s.git_branch, s.cwd, s.project_dir
       FROM findings f JOIN sessions s ON s.session_id = f.session_id
       WHERE f.cleared_at IS NULL
       ORDER BY f.id DESC`,
    )
    .all() as Array<Record<string, unknown>>;

  const byId = new Map(listSessions(true).map((s) => [s.sessionId, s]));

  return rows.map((r) => {
    const session = byId.get(String(r.session_id));
    return {
      sessionId: String(r.session_id),
      title: (r.title as string | null) ?? null,
      branch: (r.git_branch as string | null) ?? null,
      projectName: session?.projectName ?? "",
      status: session?.status ?? "unknown",
      signals: safeParse(r.signals) ?? [],
      verdict: safeParse(r.verdict),
      createdAt: String(r.created_at),
    };
  });
}

function safeParse(value: unknown): any {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

let timer: NodeJS.Timeout | null = null;

export function startScheduler(): void {
  if (timer) clearInterval(timer);
  const config = loadSupervisorConfig();
  const intervalMs = Math.max(5, config.intervalMinutes) * 60_000;
  timer = setInterval(() => {
    runOnce().catch((err) => console.error("[counter-intel] supervisor error", err));
  }, intervalMs);
  timer.unref();
  console.log(
    `[counter-intel] supervisor ${config.enabled ? "enabled" : "disabled"}` +
      `${config.enabled && config.dryRun ? " (dry-run)" : ""}` +
      ` · every ${config.intervalMinutes}m · core ${config.coreHours.start}-${config.coreHours.end} ${config.coreHours.timezone}`,
  );
}

export function restartScheduler(): void {
  startScheduler();
}

export { loadSupervisorConfig, withinCoreHours };
export type { SupervisorConfig };
