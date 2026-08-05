/**
 * Nudge text is rendered here from fixed templates and deterministic values only.
 *
 * The triage model selects a template id; it never authors the string that gets
 * typed. PR titles, review comments and CI output are attacker-influenced — they
 * reach the model, so anything the model writes has to be treated as tainted.
 * Keeping generation on this side means a hostile PR comment can at worst cause
 * the wrong template to be chosen, not arbitrary text to be injected into a
 * session running with auto-approved permissions.
 */

export interface NudgeContext {
  branch: string | null;
  prNumber: number | null;
  unpushedCommits: number;
  branchCommits: number;
  failedChecks: number;
  unresolvedThreads: number;
  idleHours: number;
}

type Renderer = (ctx: NudgeContext) => string | null;

const TEMPLATES: Record<string, Renderer> = {
  "push-unpushed-commits": (c) =>
    c.branch && c.unpushedCommits > 0
      ? `You have ${c.unpushedCommits} unpushed commit${c.unpushedCommits === 1 ? "" : "s"} on ${c.branch}. Push them.`
      : null,

  "open-pr": (c) =>
    c.branch
      ? `Branch ${c.branch} is pushed with ${c.branchCommits} commit${c.branchCommits === 1 ? "" : "s"} but has no open PR. Open one.`
      : null,

  "resolve-conflict": (c) =>
    c.prNumber
      ? `PR #${c.prNumber} has merge conflicts. Rebase on the base branch and resolve them.`
      : null,

  "fix-failing-checks": (c) =>
    c.prNumber && c.failedChecks > 0
      ? `PR #${c.prNumber} has ${c.failedChecks} failing check${c.failedChecks === 1 ? "" : "s"}. Investigate and fix them.`
      : null,

  "address-review": (c) =>
    c.prNumber
      ? `PR #${c.prNumber} has changes requested. Address the review feedback and push.`
      : null,

  "resolve-threads": (c) =>
    c.prNumber && c.unresolvedThreads > 0
      ? `PR #${c.prNumber} has ${c.unresolvedThreads} unresolved review thread${c.unresolvedThreads === 1 ? "" : "s"}. Work through them.`
      : null,

  "merge-approved": (c) =>
    c.prNumber
      ? `PR #${c.prNumber} is approved with checks passing. Merge it if nothing else is outstanding.`
      : null,

  "resume-task": (c) =>
    `This session has been idle ${Math.floor(c.idleHours)}h. Review where you left off and continue, or summarize what remains.`,
};

export const TEMPLATE_IDS = Object.keys(TEMPLATES);

const SAFE_TEXT = /^[A-Za-z0-9 #.,'/_()-]+$/;

export function renderNudge(templateId: string, ctx: NudgeContext): string | null {
  const render = TEMPLATES[templateId];
  if (!render) return null;

  const text = render(ctx);
  if (!text) return null;

  // Belt-and-braces: templates are ours, but anything typed into a live terminal
  // gets checked for shell metacharacters and embedded newlines regardless.
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length === 0 || oneLine.length > 300) return null;
  if (!SAFE_TEXT.test(oneLine)) return null;

  return oneLine;
}
