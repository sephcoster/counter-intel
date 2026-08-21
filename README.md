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

The board is split in two. The main area holds sessions **currently open in a terminal** —
those with a running `claude` process. Everything else collapses into **Not open in a terminal**
at the bottom, expandable when you want the history. The status pills count live sessions only.

A live session with no terminal (daemon- or background-spawned) stays in the main area but is
badged `no tab`, since it can be genuinely busy — even blocked — while being impossible to jump
to.

> **`/clear` does not close or archive a session.** It resets the model's context, but the
> session id, the transcript file, and the OS process all continue — a single transcript can
> contain several `/clear` records with conversation on both sides of each. So there is nothing
> in a cleared session that distinguishes it from an ordinary one. "Has a running process" is
> the only dependable signal for *open in a tab*, which is what the split uses. Closing the tab
> is what actually ends a session.

Within each area, sessions are grouped by what they need from you, most urgent first:

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

Ticket keys are matched by pattern, which is ambiguous: if your domain uses
uppercase-dash-number identifiers for anything else (`ORDER-1`, `SWITCH-2`), those look
exactly like ticket references. Declare your team keys to disambiguate, in
`~/.claude/counter-intel/config.json`:

```json
{ "linearPrefixes": ["ENG", "PLATFORM"] }
```

### What counts as a ref

Refs record what a session is *working on*, which is not the same as every identifier that
scrolled past it. The distinction matters more than it sounds: one `gh pr list` prints dozens
of PRs, `mcp__…Linear__list_issues` prints a page of tickets, `git log` prints whatever the
commit messages mention, and none of that is the session's work. Measured across 61
transcripts, a single-prompt session that asked "summarize my closed PRs" had picked up **60
PR refs, every one of them from tool output** — and across another session's 604 ticket
matches, exactly one came from text a human typed.

So each ref carries where it came from, strongest first:

| Source | Kept when |
| --- | --- |
| `prompt` | You named it. Never filtered — pasting twenty keys is deliberate |
| `created` | The session made it: `gh pr create`, `gh issue create`, a Linear write tool |
| `branch` | The git branch names it (`stefan/all-2775-…` → `ALL-2775`) |
| `prose` | You or the model discussed it, in a message mentioning ≤6 refs |
| `tool` | Tool output naming ≤2 refs — `gh pr view`, `get_issue`, not enumeration |

The two caps are what separate discussion from enumeration, and both cuts land in empty space
rather than mid-cluster. Of 90 `gh pr create` calls, every single one printed exactly **one**
PR url, while listing commands printed up to 60 — so nothing a session creates is ever lost to
the tool cap. And of 509 prose messages that mention anything, 98.6% mention six or fewer,
with nothing at all between 11 and 20.

Together this cuts stored refs by ~58% (1117 → 470 locally) while keeping every PR the agent
opened. The drawer then shows the first 12 and collapses the rest behind **+N more** — safe to
truncate precisely because the ordering puts what you named and what the session built on top.

The default is `[]`, which uses heuristics instead — hex fragments from UUIDs and commit SHAs
are dropped, along with known standards like `ISO-8601` and DeepSource codes like `JS-0045`.
Keys found inside `linear.app/.../issue/...` URLs are always trusted regardless of the list.

## Layout

```
src/server/
  indexer.ts   incremental JSONL -> SQLite
  parse.ts     record accumulator, ref extraction
  status.ts    fuses transcripts + hook events + live processes
  live.ts      process discovery, cwd via lsof
  git.ts       worktree detection
  ingest.ts    reads the hook event log
  focus.ts     jump to a tab, or through tmux when the tty is a pane
  tmux.ts      pane and client discovery across tmux sockets
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

Terminals that ship no AppleScript dictionary can't be searched by tty at all — Alacritty,
kitty, WezTerm and VS Code's integrated terminal are all invisible to the lookup above. For
those the owning application is found by walking the tty's process ancestry to its `.app`
bundle and raised with `open -a`. That reaches the right app but not the right window, since
those terminals expose no way to pick one, so the jump says which app it raised and leaves you
to glance at the front window. Ancestry is matched against the resolved executable path, so a
terminal launched through a Homebrew symlink still resolves to its bundle.

### tmux

A session running inside tmux records the tty of its **pane**, and no terminal emulator owns
that — the tab belongs to the tmux *client*, not the pane. So the tty lookup that works for a
plain tab finds nothing, and the jump has to go through tmux instead.

Panes are discovered with one `tmux list-panes -a` per socket, across every socket in
`$TMUX_TMPDIR` (so `tmux -L` servers are covered, not just the default one). A session whose
tty matches a pane is badged `tmux <session>:<window>.<pane>` on its card, and the pane is made
current before anything else happens — so however you end up there, you land on the pane rather
than wherever the session was last left.

Where the jump goes from there depends on what is attached:

| Attach state | What ⇥ does |
| --- | --- |
| A client is on that tmux session | `select-window` + `select-pane`, then focuses the tab that owns the client — a real one-click jump, or an app-level raise if that terminal isn't scriptable |
| Nothing is attached to the server | Opens a new terminal window running `tmux attach` |
| A client is attached, but to a different session | Reports where your terminal is and offers the attach as a second click — it will not `switch-client` a terminal out from under you |

The drawer also carries **Copy attach command** for the times you'd rather do it by hand. That
command targets the pane id (`tmux -S /tmp/tmux-<uid>/default attach -t %23`), which resolves to
its own session, so no session name — nothing free-text at all — ever reaches a shell string.
The socket stays explicit even when it's the default one, since the shell you paste into may
resolve `$TMUX_TMPDIR` differently than the server did.

Panes are re-resolved at click time rather than trusted from the last poll, since they move.

Pane discovery is plain `tmux`, so it works wherever tmux does; raising a tab and opening a
window are the same AppleScript path as above, so off macOS the jump reports an error and
**Copy attach command** is the way through.

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

### Acting on a finding

Each finding is clickable and carries its own actions: **Details** opens the session drawer,
**Jump to tab** focuses its terminal, **Send nudge** sends immediately, and **Dismiss** removes
it.

Dismissing suppresses that exact signal fingerprint — the finding stays gone, and later scans
skip it *before* consulting the model, so a dismissed finding costs nothing on every subsequent
run. If the situation changes the fingerprint changes with it, so a genuinely new problem still
surfaces.

Sessions whose terminal is gone are marked **no terminal** and can never be nudged; a bulk
**Dismiss N with no terminal** clears them in one click.

**Send nudge** is an explicit act, so it ignores `dryRun` — but every other guard (status, busy,
rate limit) still applies, and the attempt is logged like any other.

### Nudge safety

Injection is defended in layers, because text sent to a session sitting at a permission prompt
would answer it:

- `dryRun: true` by default — nudges are drafted, logged, and never sent
- only sessions the hook registry reports as `waiting` are eligible (never `blocked`)
- iTerm's own `is processing` flag is re-checked inside the same AppleScript as the write
- session state is re-read at send time, not trusted from the scan
- per-session rate limit and a per-run ceiling
- every attempt is recorded in `nudges` with its outcome

**tmux panes are never nudged.** The interlock above is iTerm's `is processing`, read inside
the same AppleScript as the write. tmux exposes nothing equivalent — `pane_current_command`
reads `node` whether Claude is idle, thinking, or sitting at a permission prompt — so
`send-keys` would be a write with no interlock at all, and a nudge landing on a prompt answers
it. Those findings still appear and can still be jumped to; the attempt is recorded as
`skipped-tmux` rather than failing silently.

The daemon calls `osascript` as an ordinary process, so this needs no Claude permission grant.
Adding `Bash(osascript:*)` to `~/.claude/settings.json` would grant broad GUI automation to
every session on the machine — don't.

## Not built yet

- Ask a question about a session without interrupting it (see git history for the cost analysis)
- Cross-session coordination beyond nudging
