import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface PullRequest {
  number: number;
  title: string;
  isDraft: boolean;
  mergeable: string;
  reviewDecision: string | null;
  headRefName: string;
  updatedAt: string;
  url: string;
  failedChecks: number;
  pendingChecks: number;
  unresolvedThreads: number | null;
}

async function gh(args: string[], cwd: string): Promise<string> {
  const { stdout } = await run("gh", args, {
    cwd,
    timeout: 45_000,
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8",
  });
  return stdout;
}

const PR_FIELDS = [
  "number", "title", "isDraft", "mergeable", "reviewDecision",
  "headRefName", "updatedAt", "url", "statusCheckRollup",
].join(",");

export async function listOpenPrs(cwd: string): Promise<PullRequest[]> {
  let raw: string;
  try {
    raw = await gh(
      ["pr", "list", "--author", "@me", "--state", "open", "--limit", "100", "--json", PR_FIELDS],
      cwd,
    );
  } catch {
    return [];
  }

  let parsed: Array<Record<string, unknown>>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  return parsed.map((pr) => {
    const rollup = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
    let failed = 0;
    let pending = 0;
    for (const check of rollup) {
      const c = check as Record<string, unknown>;
      const conclusion = String(c.conclusion ?? "");
      const status = String(c.status ?? "");
      if (conclusion === "FAILURE" || conclusion === "TIMED_OUT" || conclusion === "CANCELLED") failed += 1;
      else if (status === "IN_PROGRESS" || status === "QUEUED" || status === "PENDING") pending += 1;
    }
    return {
      number: Number(pr.number),
      title: String(pr.title ?? ""),
      isDraft: pr.isDraft === true,
      mergeable: String(pr.mergeable ?? "UNKNOWN"),
      reviewDecision: pr.reviewDecision ? String(pr.reviewDecision) : null,
      headRefName: String(pr.headRefName ?? ""),
      updatedAt: String(pr.updatedAt ?? ""),
      url: String(pr.url ?? ""),
      failedChecks: failed,
      pendingChecks: pending,
      unresolvedThreads: null,
    };
  });
}

const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviewThreads(first:100){ nodes { isResolved isOutdated } }
    }
  }
}`;

export async function unresolvedThreadCount(
  cwd: string,
  owner: string,
  name: string,
  number: number,
): Promise<number | null> {
  try {
    const raw = await gh(
      ["api", "graphql", "-f", `query=${THREADS_QUERY}`,
       "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${number}`],
      cwd,
    );
    const nodes = JSON.parse(raw)?.data?.repository?.pullRequest?.reviewThreads?.nodes;
    if (!Array.isArray(nodes)) return null;
    return nodes.filter((n) => n?.isResolved === false && n?.isOutdated !== true).length;
  } catch {
    return null;
  }
}

export async function repoSlug(cwd: string): Promise<{ owner: string; name: string } | null> {
  try {
    const raw = await gh(["repo", "view", "--json", "owner,name"], cwd);
    const parsed = JSON.parse(raw);
    const owner = parsed?.owner?.login;
    const name = parsed?.name;
    return owner && name ? { owner: String(owner), name: String(name) } : null;
  } catch {
    return null;
  }
}

export interface BranchState {
  exists: boolean;
  isCurrent: boolean;
  hasUpstream: boolean;
  ahead: number;
  commitsVsBase: number;
}

/**
 * State of a named branch, not of whatever the worktree happens to have checked
 * out. A long-idle session's worktree has usually moved on, so reading the
 * current branch attributes that branch's problems to every stale session.
 */
export async function branchState(cwd: string, branch: string): Promise<BranchState> {
  const git = async (args: string[]): Promise<string> => {
    try {
      const { stdout } = await run("git", args, { cwd, timeout: 20_000, encoding: "utf8" });
      return stdout.trim();
    } catch {
      return "";
    }
  };

  const missing: BranchState = {
    exists: false, isCurrent: false, hasUpstream: false, ahead: 0, commitsVsBase: 0,
  };
  if (!branch || branch === "HEAD") return missing;

  const resolved = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (!resolved) return missing;

  const current = await git(["branch", "--show-current"]);
  const upstream = await git(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
  const hasUpstream = upstream.length > 0 && !upstream.startsWith("fatal");
  const ahead = hasUpstream
    ? Number(await git(["rev-list", "--count", `${upstream}..refs/heads/${branch}`])) || 0
    : 0;

  let commitsVsBase = 0;
  for (const base of ["origin/main", "origin/master"]) {
    const count = await git(["rev-list", "--count", `${base}..refs/heads/${branch}`]);
    if (count) {
      commitsVsBase = Number(count) || 0;
      break;
    }
  }

  return { exists: true, isCurrent: current === branch, hasUpstream, ahead, commitsVsBase };
}
