# counter-intel

A local board for the Claude Code sessions running across your terminal tabs. Built for the
problem of walking away for an hour and losing track of what five or ten agents were doing,
which ones are blocked on you, and which are about to run out of context.

Everything is read from `~/.claude/` on your own machine. Nothing leaves the box.

```bash
npm install
npm run dev          # api on :4317, ui on http://localhost:4316
npm run install-hook # optional but recommended — see "Live status"
```

## What it shows

Sessions are grouped by what they need from you, most urgent first:

| Status | Meaning |
| --- | --- |
| **Needs you** | Blocked on a permission prompt or notification |
| **Waiting on you** | Claude finished its turn and is waiting for input |
| **Working** | Actively running |
| **Idle** | No recent activity |
| **Ended** | Session closed |

Each card carries the AI-generated title, the working path, git branch, a worktree badge,
linked PRs and Linear tickets, the most recent prompt, and a context gauge that turns amber
at 65% and red at 85% so you can see what needs compacting before it bites.

Clicking a card opens the full detail: your prompts separated out from the agentic tool
churn, files touched, hook event history, and a copyable `claude --resume` command.

## How it works

Two independent data sources, so the board is useful immediately and gets sharper once hooks
are installed.

**Transcript scan (no setup).** Claude Code writes newline-delimited JSON to
`~/.claude/projects/<encoded-path>/<session-id>.jsonl`. counter-intel streams those into
SQLite, tracking a byte offset per file so re-indexing only reads what was appended. Titles
come from `ai-title` records, context from the last assistant message's `usage` block, paths
and branches from the `cwd`/`gitBranch` fields stamped on every record.

**Hook registry (one command).** `npm run install-hook` appends a small script to eight
existing hook events. This is the only way to get the mapping the transcripts don't record —
which OS process and TTY belong to which session — and it's what separates "Claude is
thinking" from "Claude is blocked waiting for you to approve something". Existing hooks are
preserved and `settings.json` is backed up first. Reverse it with
`node scripts/install-hook.mjs --uninstall`.

Without hooks, status is inferred from process cwd and file mtimes and the board still works;
it just can't reliably distinguish blocked from busy.

### Context window

The transcript records the model as `claude-opus-5` even on 1M-context sessions, so the
window is inferred from observed usage: anything past 200k is treated as a 1M session.
Compaction resets the counter, which the indexer follows rather than tracking a high-water
mark.

### Linear tickets

`SWITCH-1` and `XFMR-2` are indistinguishable from real ticket keys by pattern alone, so
recognized team prefixes are an explicit allowlist in
`~/.claude/counter-intel/config.json`:

```json
{ "linearPrefixes": ["ALL", "BOLT", "CIR", "ENG", "XENG", "XEG", "INF", "INFR"] }
```

Keys found inside `linear.app/.../issue/...` URLs are always trusted regardless of the list.
Set `linearPrefixes` to `[]` to fall back to heuristics (drops hex fragments and known
standards like `ISO-8601`, `JS-0045`).

## Layout

```
src/server/
  indexer.ts   incremental JSONL -> SQLite
  parse.ts     record accumulator, ref extraction
  status.ts    fuses transcripts + hook events + live processes
  live.ts      process discovery, cwd via lsof
  git.ts       worktree detection
  ingest.ts    reads the hook event log
hooks/         the script install-hook copies into ~/.claude/hooks/
```

Subagent transcripts (`<session-id>/subagents/*.jsonl`) are deliberately skipped — they're
sidechains, not sessions.

## Jump to tab

The ⇥ button on a card (or **Jump to tab** in the drawer) focuses the terminal tab that
session is running in. It matches on TTY, which comes from the hook registry or from `ps`,
and drives iTerm2 via AppleScript with Terminal.app as a fallback.

macOS may ask for Automation permission the first time. Sessions with no recorded TTY —
background and daemon-spawned ones — don't show the button.

## Supervisor

An optional management layer that scans on an interval during core hours, finds sessions
stalled on pull requests or unlanded work, and can nudge them back into motion. Configured in
`~/.claude/counter-intel/supervisor.json`; ships **disabled and in dry-run**.

```json
{
  "enabled": false,
  "dryRun": true,
  "intervalMinutes": 45,
  "coreHours": { "start": "09:00", "end": "18:00", "days": [1,2,3,4,5], "timezone": "America/New_York" },
  "maxNudgesPerRun": 3,
  "minNudgeIntervalHours": 4,
  "maxSessionAgeHours": 72,
  "model": "claude-sonnet-5"
}
```

**Detection is deterministic and free.** One `gh pr list` per repo gives draft state,
mergeability, review decision and check rollup; one GraphQL call per PR adds unresolved review
threads; git supplies unpushed commits and pushed-but-no-PR. A 55-session scan takes ~7s and
costs nothing. Branch state is queried *by name* rather than read from the worktree — idle
worktrees move on, and reading the current branch attributes its problems to every stale
session sharing the directory.

**The model judges, it doesn't detect** — and it is gated on a fingerprint of the signal set,
so an unchanged situation reuses the stored verdict and makes no call. It earns its keep by
rejecting false positives: unpushed commits on a research branch, work deliberately parked
pending your go-ahead, signals belonging to a branch the session isn't on.

### Why the model never writes the nudge

PR titles, review comments and CI output are attacker-influenced and they reach the triage
digest. If the model authored the nudge text, anyone able to comment on a PR could write text
that gets typed into a terminal running Claude with auto-approved permissions.

So the model only picks a template id. The server renders the string from templates in
`supervisor/templates.ts` using values that come exclusively from git and `gh`. A hostile
comment can at worst cause the wrong template to be chosen. Rendered text is additionally
checked against a conservative character allowlist and a length cap before it is sent.

### Nudge safety

Injection is defended in layers, because text sent to a session sitting at a permission prompt
would answer it:

- `dryRun: true` by default — nudges are drafted, logged, and never sent
- only sessions the hook registry reports as `waiting` are eligible (never `blocked`)
- iTerm's own `is processing` flag is re-checked inside the same AppleScript as the write
- session state is re-read at send time, not trusted from the scan
- per-session rate limit and a per-run ceiling
- every attempt is recorded in `nudges` with its outcome

The daemon calls `osascript` as an ordinary process, so this needs no Claude permission grant.
Adding `Bash(osascript:*)` to `~/.claude/settings.json` would grant broad GUI automation to
every session on the machine — don't.

## Not built yet

- Ask a question about a session without interrupting it (see git history for the cost analysis)
- Cross-session coordination beyond nudging
