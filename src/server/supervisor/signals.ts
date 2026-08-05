import { createHash } from "node:crypto";
import { listOpenPrs, unresolvedThreadCount, repoSlug, branchState, type PullRequest } from "./gh.js";
import { repoInfo } from "../git.js";
import type { SessionSummary } from "../../shared/types.js";
import type { SupervisorConfig } from "./config.js";

export type Severity = "high" | "medium" | "low";

export interface Signal {
  key: string;
  severity: Severity;
  summary: string;
}

export interface SessionFindings {
  session: SessionSummary;
  signals: Signal[];
  fingerprint: string;
  pr: PullRequest | null;
}

function hoursSince(iso: string | null): number {
  if (!iso) return Infinity;
  const delta = Date.now() - Date.parse(iso);
  return Number.isFinite(delta) ? delta / 3_600_000 : Infinity;
}

async function prsForRepo(cwd: string, cache: Map<string, PullRequest[]>): Promise<PullRequest[]> {
  const root = repoInfo(cwd).root ?? cwd;
  const cached = cache.get(root);
  if (cached) return cached;
  const prs = await listOpenPrs(root);
  cache.set(root, prs);
  return prs;
}

async function prSignals(
  cwd: string,
  pr: PullRequest,
  threadCache: Map<string, number | null>,
): Promise<Signal[]> {
  const out: Signal[] = [];
  const root = repoInfo(cwd).root ?? cwd;

  if (pr.mergeable === "CONFLICTING") {
    out.push({ key: "pr-conflicting", severity: "high", summary: `PR #${pr.number} has merge conflicts` });
  }
  if (pr.failedChecks > 0) {
    out.push({
      key: `pr-checks-failing:${pr.failedChecks}`,
      severity: "high",
      summary: `PR #${pr.number} has ${pr.failedChecks} failing check${pr.failedChecks === 1 ? "" : "s"}`,
    });
  }
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    out.push({
      key: "pr-changes-requested",
      severity: "high",
      summary: `PR #${pr.number} has changes requested`,
    });
  }

  const threadKey = `${root}#${pr.number}`;
  if (!threadCache.has(threadKey)) {
    const slug = await repoSlug(root);
    threadCache.set(
      threadKey,
      slug ? await unresolvedThreadCount(root, slug.owner, slug.name, pr.number) : null,
    );
  }
  const unresolved = threadCache.get(threadKey) ?? null;
  if (unresolved !== null && unresolved > 0) {
    out.push({
      key: `pr-unresolved-threads:${unresolved}`,
      severity: "high",
      summary: `PR #${pr.number} has ${unresolved} unresolved review thread${unresolved === 1 ? "" : "s"}`,
    });
  }

  if (
    pr.reviewDecision === "APPROVED" &&
    pr.failedChecks === 0 &&
    pr.pendingChecks === 0 &&
    !pr.isDraft &&
    pr.mergeable !== "CONFLICTING"
  ) {
    out.push({
      key: "pr-approved-unmerged",
      severity: "medium",
      summary: `PR #${pr.number} is approved and green but not merged`,
    });
  }

  if (pr.isDraft && hoursSince(pr.updatedAt) > 48) {
    out.push({
      key: "pr-draft-stale",
      severity: "low",
      summary: `PR #${pr.number} has been a draft for ${Math.floor(hoursSince(pr.updatedAt) / 24)}d`,
    });
  }

  return out;
}

export async function detect(
  sessions: SessionSummary[],
  config: SupervisorConfig,
): Promise<SessionFindings[]> {
  const prCache = new Map<string, PullRequest[]>();
  const threadCache = new Map<string, number | null>();
  const branchCache = new Map<string, Awaited<ReturnType<typeof branchState>>>();
  const out: SessionFindings[] = [];

  for (const session of sessions) {
    if (!session.cwd || session.isSidechain) continue;
    if (session.status === "ended") continue;
    // A session nobody has touched in days isn't stalled, it's finished with.
    if (hoursSince(session.updatedAt) > config.maxSessionAgeHours) continue;

    const signals: Signal[] = [];
    const root = repoInfo(session.cwd).root ?? session.cwd;
    const branch = session.gitBranch;

    let pr: PullRequest | null = null;
    let git: Awaited<ReturnType<typeof branchState>> | null = null;

    if (branch && branch !== "HEAD") {
      const cacheKey = `${root}::${branch}`;
      if (!branchCache.has(cacheKey)) branchCache.set(cacheKey, await branchState(root, branch));
      git = branchCache.get(cacheKey)!;

      const prs = await prsForRepo(session.cwd, prCache);
      pr = prs.find((p) => p.headRefName === branch) ?? null;
    }

    if (pr) {
      signals.push(...(await prSignals(session.cwd, pr, threadCache)));
    } else if (git?.exists && branch && branch !== "main" && branch !== "master") {
      if (git.ahead > 0) {
        signals.push({
          key: `unpushed-commits:${git.ahead}`,
          severity: "high",
          summary: `${git.ahead} commit${git.ahead === 1 ? "" : "s"} on ${branch} not pushed`,
        });
      } else if (git.hasUpstream && git.commitsVsBase > 0) {
        signals.push({
          key: "branch-no-pr",
          severity: "medium",
          summary: `${branch} is pushed with ${git.commitsVsBase} commit${git.commitsVsBase === 1 ? "" : "s"} but has no open PR`,
        });
      }
    }

    // Idle-mid-task is only a candidate signal — whether the work is actually
    // unfinished is a judgment call, so it's left to triage.
    const idleHours = hoursSince(session.updatedAt);
    if (
      (session.status === "waiting" || session.status === "blocked") &&
      idleHours >= config.idleHoursBeforeStuck &&
      idleHours < 24 * 7
    ) {
      signals.push({
        key: `idle-mid-task:${Math.floor(idleHours)}h`,
        severity: "medium",
        summary: `Session idle ${Math.floor(idleHours)}h while ${session.status}`,
      });
    }

    if (signals.length === 0) continue;

    const fingerprint = createHash("sha256")
      .update(session.sessionId)
      .update(signals.map((s) => s.key).sort().join("|"))
      .digest("hex")
      .slice(0, 16);

    out.push({ session, signals, fingerprint, pr });
  }

  return out;
}
