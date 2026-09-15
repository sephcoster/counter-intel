import { harvestRefs, harvestToolOutput, type Accumulator } from "./parse.js";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((block) => {
    const b = object(block);
    return ["input_text", "output_text", "text"].includes(String(b.type)) && typeof b.text === "string"
      ? b.text : "";
  }).filter(Boolean).join("\n");
}

function isInjectedMessage(payload: Record<string, unknown>, text: string): boolean {
  const kinds = object(payload.internal_chat_message_metadata_passthrough).content_item_kinds;
  if (Array.isArray(kinds) && kinds.length > 0) {
    return !kinds.some((kind) => typeof kind === "string" && kind.startsWith("user."));
  }
  // Older rollouts have no content metadata. Exclude known context injections,
  // while preserving actual prompts that happen to contain XML or Markdown.
  return /^(?:# AGENTS\.md instructions for |<(?:environment_context|permissions instructions|INSTRUCTIONS|skills_instructions|turn_aborted|subagent_notification)>)/.test(text.trimStart());
}

function usage(acc: Accumulator, value: unknown): void {
  const input = object(value).input_tokens;
  // Cached input is already included. Cumulative session usage isn't context.
  if (typeof input === "number" && Number.isFinite(input) && input >= 0) acc.contextTokens = input;
}

function windowSize(acc: Accumulator, value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) acc.contextWindow = value;
}

function touch(acc: Accumulator, path: string, ts: string | null): void {
  const prev = acc.files.get(path);
  acc.files.set(path, { count: (prev?.count ?? 0) + 1, lastSeen: ts });
}

/** Parse Codex rollout records. The byte offset gives id-less older records stable IDs. */
export function applyCodexLine(acc: Accumulator, raw: string, offset: number): void {
  let rec: Record<string, unknown>;
  try { rec = object(JSON.parse(raw)); } catch { return; }
  const p = object(rec.payload);
  const ts = typeof rec.timestamp === "string" ? rec.timestamp : null;
  if (ts) {
    acc.createdAt ??= ts;
    acc.updatedAt = ts;
  }

  if (rec.type === "session_meta") {
    if (typeof p.id === "string") acc.sessionId = p.id;
    if (typeof p.cwd === "string") acc.cwd = p.cwd;
    if (typeof p.cli_version === "string") acc.version = p.cli_version;
    const branch = object(p.git).branch;
    if (typeof branch === "string") {
      acc.gitBranch = branch;
      harvestRefs(acc, branch.toUpperCase(), ts, "branch");
    }
    acc.isSidechain = object(p.source).subagent !== undefined || p.source === "subagent";
    return;
  }
  if (rec.type === "turn_context") {
    if (typeof p.cwd === "string") acc.cwd = p.cwd;
    if (typeof p.model === "string") acc.model = p.model;
    if (typeof p.approval_policy === "string") acc.permissionMode = p.approval_policy;
    return;
  }
  if (rec.type === "token_usage_record") {
    usage(acc, p.usage);
    return;
  }
  if (rec.type === "event_msg") {
    windowSize(acc, p.model_context_window);
    if (p.type === "token_count") {
      const info = object(p.info);
      usage(acc, info.last_token_usage);
      windowSize(acc, info.model_context_window);
    }
    const type = String(p.type ?? "");
    if (type === "task_started" || type === "turn_started") acc.transcriptStatus = "working";
    else if (["task_complete", "turn_complete", "turn_aborted"].includes(type)) acc.transcriptStatus = "waiting";
    else if (type !== "context_compacted") return;
    acc.events.push({ id: offset, event: type, ts, cwd: acc.cwd });
    // Messages are read from response_item only: event_msg repeats the same text.
    return;
  }
  if (rec.type !== "response_item") return;

  if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
    const text = textContent(p.content);
    if (p.role === "user" && isInjectedMessage(p, text)) return;
    acc.messageCount += 1;
    acc.seq += 1;
    if (p.role === "user") {
      if (acc.transcriptStatus !== null) acc.transcriptStatus = "working";
      acc.userMessageCount += 1;
      if (text.trim()) {
        acc.firstPrompt ??= text.slice(0, 500);
        acc.lastPrompt = text.slice(0, 500);
      }
    } else if (p.phase === "final_answer") {
      acc.transcriptStatus = "waiting";
    }
    harvestRefs(acc, text, ts, p.role === "user" ? "prompt" : "prose");
    if (text.trim()) acc.turns.push({
      uuid: typeof p.id === "string" ? p.id : `codex:${offset}`,
      ts, role: p.role, text: text.slice(0, p.role === "user" ? 2000 : 1200),
    });
    return;
  }

  if (p.type === "function_call" || p.type === "custom_tool_call") {
    const name = String(p.name ?? "");
    let args: Record<string, unknown> = {};
    try { args = object(JSON.parse(String(p.arguments ?? "{}"))); } catch { /* custom tool input */ }
    const command = textContent(args.cmd ?? args.command ?? p.input);
    if (typeof p.call_id === "string") acc.toolCalls.set(p.call_id, { command, name });
    harvestToolOutput(acc, command, ts, { command, name });
    if (typeof args.file_path === "string") touch(acc, args.file_path, ts);
    if (/(?:^|[._])apply_patch$/.test(name)) {
      const patch = textContent(p.input ?? args.patch ?? args.input);
      for (const match of patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)) touch(acc, match[1], ts);
    }
    if (/(?:^|[._])request_user_input$/.test(name)) acc.transcriptStatus = "blocked";
    else if (acc.transcriptStatus !== null) acc.transcriptStatus = "working";
    return;
  }
  if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
    const id = String(p.call_id ?? "");
    const invoked = acc.toolCalls.get(id);
    harvestToolOutput(acc, textContent(p.output), ts, invoked);
    acc.toolCalls.delete(id);
    if (acc.transcriptStatus !== null) acc.transcriptStatus = "working";
  }
}
