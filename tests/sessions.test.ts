import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { explicitSessionId, providerForCommand, rolloutSessions, type LiveProc } from "../src/server/live.js";
import { resumeCommand } from "../src/shared/provider.js";

const root = mkdtempSync(join(tmpdir(), "counter-intel-test-"));
process.env.COUNTER_INTEL_HOME = root;
process.env.COUNTER_INTEL_DB = join(root, "test.db");
process.env.COUNTER_INTEL_PROJECTS = join(root, "claude");
process.env.COUNTER_INTEL_CODEX_SESSIONS = join(root, "codex");
const { applyCodexLine } = await import("../src/server/codex.js");
const { emptyAccumulator } = await import("../src/server/parse.js");
const { db } = await import("../src/server/db.js");
const { indexAll, discoverTranscripts } = await import("../src/server/indexer.js");
const { deriveStatus, matchProcess, listSessions, getSession } = await import("../src/server/status.js");
const id = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const ts = "2026-09-15T15:00:00.000Z";
const record = (type: string, payload: unknown) => JSON.stringify({ timestamp: ts, type, payload }) + "\n";
const message = (role: string, text: string) => record("response_item", {
  type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }],
});
const meta = (sessionId = id, source: unknown = "cli") => record("session_meta", {
  id: sessionId, cwd: root, cli_version: "0.154.0", source, git: { branch: "feature/eng-123" },
});
function rollout(content: string, sessionId = id): string {
  const dir = join(root, "codex", "2026", "09", "15");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-09-15T11-00-00-${sessionId}.jsonl`);
  writeFileSync(path, content);
  return path;
}
function parse(content: string) {
  const acc = emptyAccumulator();
  let offset = 0;
  for (const line of content.split("\n")) {
    applyCodexLine(acc, line, offset);
    offset += Buffer.byteLength(line) + 1;
  }
  return acc;
}
function proc(overrides: Partial<LiveProc> = {}): LiveProc {
  return { provider: "codex", sessionIds: [], pid: 42, ppid: 1, tty: "ttys005", cwd: root, command: "codex", ...overrides };
}

beforeEach(() => {
  for (const table of ["sessions", "session_refs", "session_files", "turns", "transcript_events", "hook_events"]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  rmSync(join(root, "codex"), { recursive: true, force: true });
  rmSync(join(root, "claude"), { recursive: true, force: true });
});
after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

test("Codex messages exclude context injections, event duplicates and reasoning", () => {
  const acc = parse(meta() +
    message("user", "# AGENTS.md instructions for /repo\nENG-999") +
    message("user", "<environment_context>ENG-998</environment_context>") +
    record("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Injected ENG-997" }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ["environments.environment_context"] } }) +
    message("developer", "ENG-996") + message("user", "Fix ENG-123") +
    record("event_msg", { type: "user_message", message: "Fix ENG-123" }) +
    message("assistant", "Working on ENG-123") +
    record("event_msg", { type: "agent_message", message: "Working on ENG-123" }) +
    record("response_item", { type: "reasoning", summary: [{ text: "ENG-995" }] }));
  assert.equal(acc.messageCount, 2);
  assert.equal(acc.userMessageCount, 1);
  assert.deepEqual(acc.turns.map((t) => t.text), ["Fix ENG-123", "Working on ENG-123"]);
  assert.equal(acc.firstPrompt, "Fix ENG-123");
  assert.equal(acc.lastPrompt, "Fix ENG-123");
  assert.deepEqual([...acc.refs.keys()], ["linear:ENG-123"]);
  assert.equal(acc.refs.get("linear:ENG-123")?.rank, 0);
});

test("Codex context uses latest input, counts cached tokens once and follows compaction", () => {
  const acc = parse(meta() + record("turn_context", { model: "gpt-6-astra", approval_policy: "on-request" }) +
    record("event_msg", { type: "task_started", model_context_window: 258400 }) +
    record("event_msg", { type: "token_count", info: { model_context_window: 258400,
      total_token_usage: { input_tokens: 900000 }, last_token_usage: { input_tokens: 100000, cached_input_tokens: 80000 } } }));
  assert.equal(acc.contextTokens, 100000);
  assert.equal(acc.contextWindow, 258400);
  assert.equal(acc.model, "gpt-6-astra");
  applyCodexLine(acc, record("token_usage_record", { usage: { input_tokens: 12000, cached_input_tokens: 8000 } }), 1);
  assert.equal(acc.contextTokens, 12000);
  applyCodexLine(acc, record("event_msg", { type: "token_count", info: null }), 2);
  assert.equal(acc.contextTokens, 12000);
  for (const invalid of ["null", "{", "[]", record("event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: "oops" } } })]) {
    assert.doesNotThrow(() => applyCodexLine(acc, invalid, 3));
  }
  assert.equal(acc.contextTokens, 12000);
});

test("turn events distinguish work, user input and completion", () => {
  const acc = parse(meta() + record("event_msg", { type: "task_started" }));
  assert.equal(acc.transcriptStatus, "working");
  applyCodexLine(acc, record("response_item", { type: "function_call", name: "request_user_input", call_id: "q", arguments: "{}" }), 1);
  assert.equal(acc.transcriptStatus, "blocked");
  applyCodexLine(acc, record("response_item", { type: "function_call_output", call_id: "q", output: "answer" }), 2);
  assert.equal(acc.transcriptStatus, "working");
  for (const event of ["task_complete", "turn_aborted"]) {
    applyCodexLine(acc, record("event_msg", { type: event }), 3);
    assert.equal(acc.transcriptStatus, "waiting");
  }
  assert.deepEqual(acc.events.map((e) => e.event), ["task_started", "task_complete", "turn_aborted"]);
});

test("discovers Codex without Claude installed and hides Codex subagents", () => {
  rollout(meta() + message("user", "Hello"));
  rollout(meta(otherId, { subagent: { other: "guardian" } }), otherId);
  assert.equal(discoverTranscripts().length, 2);
  assert.equal(indexAll().updated, 2);
  assert.deepEqual(listSessions().map((s) => s.sessionId), [id]);
  assert.equal(listSessions(true).length, 2);
});

test("incremental reads preserve usage, tool provenance, UTF-8 and stable turn IDs", () => {
  const content = meta() + message("user", "Fix ENG-123") +
    record("event_msg", { type: "task_started", model_context_window: 258400 }) +
    record("response_item", { type: "function_call", name: "exec_command", call_id: "create", arguments: JSON.stringify({ cmd: "gh pr create" }) });
  const path = rollout(content);
  indexAll();
  assert.equal(indexAll().updated, 0);
  const append = Buffer.from(record("response_item", { type: "function_call_output", call_id: "create", output: "https://github.com/org/repo/pull/12" }) +
    message("assistant", "Done ✓"));
  // Split inside the UTF-8 character and leave the JSON line incomplete.
  const split = append.indexOf(Buffer.from("✓")) + 1;
  appendFileSync(path, append.subarray(0, split));
  indexAll();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM turns").get().n, 1);
  appendFileSync(path, append.subarray(split));
  appendFileSync(path, record("event_msg", { type: "task_complete" }));
  indexAll();
  const detail = getSession(id)!;
  assert.equal(detail.provider, "codex");
  assert.equal(detail.contextWindow, 258400);
  assert.deepEqual(detail.turns.map((t) => t.text), ["Fix ENG-123", "Done ✓"]);
  assert.equal(detail.refs.find((r) => r.kind === "pr")?.source, "created");
  assert.deepEqual(detail.recentEvents.map((e) => e.event), ["task_complete", "task_started"]);
  const ids = detail.turns.map((t) => t.uuid);
  indexAll(true);
  assert.deepEqual(getSession(id)!.turns.map((t) => t.uuid), ids);
  assert.equal(getSession(id)!.messageCount, 2);
});

test("rewritten transcripts clear stale metadata and derived rows atomically", () => {
  const path = rollout(meta() + message("user", "Fix ENG-123") + message("assistant", "Old response"));
  indexAll();
  writeFileSync(path, meta() + message("user", "New prompt"));
  indexAll();
  assert.equal(getSession(id)!.firstPrompt, "New prompt");
  assert.equal(getSession(id)!.turns.length, 1);
  const size = statSync(path).size;
  writeFileSync(path, meta() + message("user", "New result"));
  assert.equal(statSync(path).size, size);
  const modified = new Date(Date.now() + 2000);
  utimesSync(path, modified, modified);
  indexAll();
  assert.equal(getSession(id)!.firstPrompt, "New result");
});

test("Claude records and hooks continue to work alongside Codex", () => {
  const dir = join(root, "claude", "project");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${otherId}.jsonl`), JSON.stringify({ type: "user", sessionId: otherId, cwd: root,
    timestamp: ts, uuid: "u1", message: { content: "Claude task" } }) + "\n" +
    JSON.stringify({ type: "assistant", timestamp: ts, uuid: "a1", message: { model: "claude-sonnet-5",
      usage: { input_tokens: 2000, cache_read_input_tokens: 1000 }, content: [{ type: "text", text: "Done" }] } }) + "\n");
  rollout(meta() + message("user", "Codex task"));
  assert.equal(indexAll().updated, 2);
  const claude = getSession(otherId)!;
  assert.equal(claude.provider, "claude");
  assert.equal(claude.contextTokens, 3000);
  assert.equal(claude.contextWindow, 200000);
  const now = Date.parse(ts);
  assert.deepEqual(deriveStatus({ provider: "claude", file_mtime: now },
    { session_id: otherId, event: "Stop", pid: 9, tty: "ttys002", ts }, null, now), { status: "waiting", source: "hook" });
});

test("file edits and custom tool outputs appear in Codex details", () => {
  const acc = parse(meta() +
    record("response_item", { type: "custom_tool_call", name: "apply_patch", call_id: "patch", input: "*** Begin Patch\n*** Update File: src/app.ts\n*** Move to: src/main.ts\n*** End Patch" }) +
    record("response_item", { type: "custom_tool_call_output", call_id: "patch", output: [{ type: "input_text", text: "https://github.com/org/repo/pull/2" }] }));
  assert.deepEqual([...acc.files.keys()], ["src/app.ts", "src/main.ts"]);
  assert.equal(acc.refs.get("pr:org/repo#2")?.rank, 4);
});

test("process detection recognizes launchers and app servers without helpers or shell commands", () => {
  for (const command of ["codex", "node /usr/bin/codex", "/usr/bin/node /usr/bin/codex.js", "/Applications/Codex.app/Contents/Resources/codex app-server", "codex fix the login page and mcp tools"]) {
    assert.equal(providerForCommand(command), "codex", command);
  }
  for (const command of ["codex-code-mode-host", "codex mcp-server", "rg codex", "/bin/zsh -c codex", "node monitor.js codex"]) {
    assert.equal(providerForCommand(command), null, command);
  }
  assert.equal(providerForCommand("claude"), "claude");
  assert.equal(providerForCommand("claude --bg-pty-host"), null);
  assert.equal(explicitSessionId(`codex resume ${id}`, "codex"), id);
  assert.equal(explicitSessionId(`codex fork ${id}`, "codex"), null);
  assert.equal(explicitSessionId(`claude --session-id ${id}`), id);
  const found = rolloutSessions(`p42\nn/tmp/rollout-2026-09-15T11-00-00-${id}.jsonl\nn/tmp/rollout-2026-09-15T11-00-00-${otherId}.jsonl\np43\nn/tmp/other.jsonl`);
  assert.deepEqual(found.get(42), [id, otherId]);
  assert.equal(found.has(43), false);
});

test("matching isolates providers and reserves exact IDs ahead of cwd heuristics", () => {
  const row = { provider: "codex", cwd: root, session_id: id };
  assert.equal(matchProcess(row, undefined, [proc({ provider: "claude" })], new Set()), null);
  assert.equal(matchProcess(row, undefined, [proc({ sessionIds: [otherId] })], new Set()), null);
  assert.equal(matchProcess(row, undefined, [proc({ command: `codex resume ${otherId}` })], new Set()), null);
  assert.equal(matchProcess(row, undefined, [proc({ command: "codex app-server" })], new Set()), null);
  assert.equal(matchProcess(row, undefined, [proc()], new Set([42])), null);
  assert.equal(matchProcess(row, undefined, [proc({ sessionIds: [id, otherId] })], new Set([42]))?.pid, 42);
  assert.equal(matchProcess(row, undefined, [proc()], new Set())?.pid, 42);
});

test("Codex turn state remains working during long tools but dead processes are idle", () => {
  const row = { provider: "codex", transcript_status: "working", file_mtime: 0 };
  assert.deepEqual(deriveStatus(row, undefined, proc(), Date.now()), { status: "working", source: "transcript" });
  assert.deepEqual(deriveStatus({ ...row, transcript_status: "waiting" }, undefined, proc(), Date.now()), { status: "waiting", source: "transcript" });
  assert.deepEqual(deriveStatus(row, undefined, null, Date.now()), { status: "idle", source: "process" });
  const legacy = parse(meta() + message("user", "Hello") + message("assistant", "Done"));
  assert.equal(legacy.transcriptStatus, null);
  assert.deepEqual(deriveStatus({ ...row, transcript_status: legacy.transcriptStatus }, undefined, proc(), Date.now()), { status: "waiting", source: "process" });
});

test("one app server can match multiple local threads without a terminal", () => {
  const app = proc({ command: "/Applications/Codex.app/Contents/Resources/codex app-server", tty: null,
    sessionIds: rolloutSessions(`p42\nn/tmp/rollout-2026-09-15T11-00-00-${id}.jsonl\nn/tmp/rollout-2026-09-15T11-00-00-${otherId}.jsonl`).get(42)! });
  const claimed = new Set<number>();
  for (const sessionId of [id, otherId]) {
    const row = { provider: "codex", session_id: sessionId, cwd: root, transcript_status: "waiting" };
    const matched = matchProcess(row, undefined, [app], claimed);
    assert.equal(matched, app);
    assert.equal(matched?.tty, null);
    assert.deepEqual(deriveStatus(row, undefined, matched, Date.now()), { status: "waiting", source: "transcript" });
    claimed.add(app.pid);
  }
  assert.equal(matchProcess({ provider: "codex", session_id: "unloaded-thread", cwd: root }, undefined, [app], claimed), null);
});

test("resume commands use each provider and preserve shell metacharacters in paths", () => {
  const cwd = join(root, "path with 'quotes' and $variables");
  mkdirSync(cwd);
  for (const provider of ["claude", "codex"] as const) {
    const command = resumeCommand({ provider, sessionId: id, cwd });
    assert.ok(command.includes(provider === "codex" ? "codex resume" : "claude --resume"));
    const cd = command.split(" && ")[0];
    assert.equal(execFileSync("/bin/sh", ["-c", `${cd} && pwd -P`], { encoding: "utf8" }).trim(),
      execFileSync("/bin/pwd", ["-P"], { cwd, encoding: "utf8" }).trim());
  }
});
