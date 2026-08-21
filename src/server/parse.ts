import { loadConfig } from "./config.js";

const PR_RE = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g;
const LINEAR_URL_RE = /https?:\/\/linear\.app\/[\w-]+\/issue\/([A-Z][A-Z0-9]{1,5}-\d{1,6})/g;
// Letters-only prefix: real team keys (ALL, CIR, BOLT, INFR) never contain digits, while
// the uppercase-hex fragments these transcripts are full of (D5BE-7879, CED8-2126) always do.
const LINEAR_KEY_RE = /\b([A-Z]{2,6}-\d{1,5})\b/g;

// Heuristic fallback, used only when no allowlist is configured.
const STANDARD_PREFIXES = new Set([
  "UTF", "ISO", "RFC", "NAD", "SHA", "MD", "ES", "HTTP", "TLS", "IPV", "PG", "NODE",
  "CVE", "CWE", "AES", "RSA", "BASE", "GPT", "IEEE", "ECMA", "BSD", "LGPL", "GPL",
  "MIT", "EPSG", "ITRF", "JS", "PY", "TS", "ABC", "FOO", "XXX",
]);

// Uppercase hex fragments (ABFA-7053, DCEE-6849) fall out of UUIDs and commit SHAs.
const HEX_ONLY = /^[A-F]+$/;

/**
 * How a ref came to be attached to a session, strongest first. A ref seen from several
 * sources keeps its strongest rank, which is what makes truncating the display safe.
 */
export const REF_SOURCES = ["prompt", "created", "branch", "prose", "tool"] as const;
export type RefSource = (typeof REF_SOURCES)[number];
export const refSourceRank = (source: RefSource): number => REF_SOURCES.indexOf(source);
export const refSourceFor = (rank: number): RefSource => REF_SOURCES[rank] ?? "tool";

// Commands whose output names something the session just brought into existence. Verified
// against 90 `gh pr create` calls: every one printed exactly one PR url, while listing
// commands printed up to 60.
const CREATING_COMMAND = /\bgh\s+(pr|issue)\s+create\b/;
const CREATING_TOOL = /(save_issue|create_issue|save_comment|create_attachment)/;

// Tool output below this many refs is a deliberate single-target operation (`gh pr view`,
// `get_issue`); above it, bulk enumeration whose contents the session merely saw.
const TOOL_REF_CAP = 2;

/**
 * A model summary that lists forty PRs is the same enumeration, just laundered through
 * prose. Across 509 prose messages that mention anything, 98.6% mention six or fewer and
 * nothing falls between 11 and 20 — so the cut lands in real empty space, not mid-cluster.
 * Prompts are never capped: pasting twenty ticket keys is a deliberate human act.
 */
const PROSE_REF_CAP = 6;

function looksLikeTicket(key: string, allowlist: Set<string>): boolean {
  const prefix = key.split("-")[0] ?? "";
  if (allowlist.size > 0) return allowlist.has(prefix);
  if (STANDARD_PREFIXES.has(prefix)) return false;
  if (prefix.length >= 3 && HEX_ONLY.test(prefix)) return false;
  return true;
}

export interface Accumulator {
  sessionId: string | null;
  cwd: string | null;
  gitBranch: string | null;
  title: string | null;
  firstPrompt: string | null;
  lastPrompt: string | null;
  mode: string | null;
  permissionMode: string | null;
  model: string | null;
  version: string | null;
  messageCount: number;
  userMessageCount: number;
  createdAt: string | null;
  updatedAt: string | null;
  contextTokens: number;
  isSidechain: boolean;
  refs: Map<string, { kind: string; value: string; lastSeen: string | null; rank: number }>;
  /** tool_use id -> what invoked it, so a tool_result can be judged by its command. */
  toolCalls: Map<string, { command: string; name: string }>;
  files: Map<string, { count: number; lastSeen: string | null }>;
  turns: Array<{ uuid: string; ts: string | null; role: "user" | "assistant"; text: string }>;
  seq: number;
}

export function emptyAccumulator(): Accumulator {
  return {
    sessionId: null, cwd: null, gitBranch: null, title: null,
    firstPrompt: null, lastPrompt: null, mode: null, permissionMode: null,
    model: null, version: null, messageCount: 0, userMessageCount: 0,
    createdAt: null, updatedAt: null, contextTokens: 0, isSidechain: false,
    refs: new Map(), toolCalls: new Map(), files: new Map(), turns: [], seq: 0,
  };
}

function blocksToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b.type === "thinking" && typeof b.thinking === "string") continue;
    else if (b.type === "tool_result") {
      const c = b.content;
      if (typeof c === "string") parts.push(c);
      else if (Array.isArray(c)) parts.push(blocksToText(c));
    }
  }
  return parts.join("\n");
}

// Same as blocksToText minus tool_result, which is where bulk enumeration lands.
function proseToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

function matchRefs(text: string): Array<{ kind: string; value: string }> {
  const out: Array<{ kind: string; value: string }> = [];
  if (!text) return out;
  for (const m of text.matchAll(PR_RE)) out.push({ kind: "pr", value: `${m[1]}/${m[2]}#${m[3]}` });
  for (const m of text.matchAll(LINEAR_URL_RE)) out.push({ kind: "linear", value: m[1] });
  const allowlist = new Set(loadConfig().linearPrefixes);
  for (const m of text.matchAll(LINEAR_KEY_RE)) {
    if (looksLikeTicket(m[1], allowlist)) out.push({ kind: "linear", value: m[1] });
  }
  return out;
}

function record(
  acc: Accumulator,
  found: Array<{ kind: string; value: string }>,
  ts: string | null,
  source: RefSource,
): void {
  const rank = refSourceRank(source);
  for (const { kind, value } of found) {
    const key = `${kind}:${value}`;
    const prev = acc.refs.get(key);
    acc.refs.set(key, {
      kind,
      value,
      lastSeen: ts ?? prev?.lastSeen ?? null,
      rank: prev ? Math.min(prev.rank, rank) : rank,
    });
  }
}

function harvestRefs(acc: Accumulator, text: string, ts: string | null, source: RefSource): void {
  const found = matchRefs(text);
  if (source === "prose" && distinctCount(found) > PROSE_REF_CAP) return;
  record(acc, found, ts, source);
}

function distinctCount(found: Array<{ kind: string; value: string }>): number {
  return new Set(found.map((f) => `${f.kind}:${f.value}`)).size;
}

/**
 * Tool output records what a session *saw*, which for one `gh pr list` is dozens of PRs it
 * has nothing to do with. Only creations and small single-target results are taken.
 */
function harvestToolOutput(
  acc: Accumulator,
  text: string,
  ts: string | null,
  invoked: { command: string; name: string } | undefined,
): void {
  const found = matchRefs(text);
  if (found.length === 0) return;
  const creating =
    CREATING_COMMAND.test(invoked?.command ?? "") || CREATING_TOOL.test(invoked?.name ?? "");
  if (creating) return record(acc, found, ts, "created");
  if (distinctCount(found) <= TOOL_REF_CAP) {
    record(acc, found, ts, "tool");
  }
}

const FILE_TOOLS = new Set(["Edit", "Write", "Read", "NotebookEdit", "MultiEdit"]);

export function applyLine(acc: Accumulator, raw: string): void {
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(raw);
  } catch {
    return;
  }

  const type = rec.type;
  const ts = typeof rec.timestamp === "string" ? rec.timestamp : null;

  if (typeof rec.sessionId === "string") acc.sessionId = rec.sessionId;
  if (typeof rec.cwd === "string") acc.cwd = rec.cwd;
  if (typeof rec.gitBranch === "string" && rec.gitBranch) {
    if (acc.gitBranch !== rec.gitBranch) {
      // Branch names carry the ticket the work is actually for (`stefan/all-2775-...`),
      // which no amount of transcript text establishes as reliably.
      harvestRefs(acc, rec.gitBranch.toUpperCase(), ts, "branch");
    }
    acc.gitBranch = rec.gitBranch;
  }
  if (typeof rec.version === "string") acc.version = rec.version;
  if (rec.isSidechain === true) acc.isSidechain = true;
  if (ts) {
    if (!acc.createdAt) acc.createdAt = ts;
    acc.updatedAt = ts;
  }

  switch (type) {
    case "ai-title":
      if (typeof rec.aiTitle === "string") acc.title = rec.aiTitle;
      return;
    case "last-prompt":
      if (typeof rec.lastPrompt === "string") acc.lastPrompt = rec.lastPrompt;
      return;
    case "mode":
      if (typeof rec.mode === "string") acc.mode = rec.mode;
      return;
    case "permission-mode":
      if (typeof rec.permissionMode === "string") acc.permissionMode = rec.permissionMode;
      return;
    case "user":
    case "assistant":
      break;
    default:
      return;
  }

  const message = rec.message as Record<string, unknown> | undefined;
  if (!message) return;
  acc.messageCount += 1;

  if (type === "assistant") {
    if (typeof message.model === "string") acc.model = message.model;
    const usage = message.usage as Record<string, unknown> | undefined;
    if (usage) {
      const input = Number(usage.input_tokens ?? 0);
      const create = Number(usage.cache_creation_input_tokens ?? 0);
      const read = Number(usage.cache_read_input_tokens ?? 0);
      const total = input + create + read;
      // Compaction resets the window, so track the latest value rather than the max.
      if (total > 0) acc.contextTokens = total;
    }
    const text = blocksToText(message.content);
    harvestRefs(acc, proseToText(message.content), ts, "prose");
    if (text.trim()) {
      acc.turns.push({
        uuid: String(rec.uuid ?? `a${acc.seq}`),
        ts,
        role: "assistant",
        text: text.slice(0, 1200),
      });
    }
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        const b = block as Record<string, unknown>;
        if (b?.type !== "tool_use") continue;
        const name = String(b.name ?? "");
        const input = b.input as Record<string, unknown> | undefined;
        const fp = input?.file_path;
        if (FILE_TOOLS.has(name) && typeof fp === "string") {
          const prev = acc.files.get(fp);
          acc.files.set(fp, { count: (prev?.count ?? 0) + 1, lastSeen: ts });
        }
        if (typeof b.id === "string") {
          acc.toolCalls.set(String(b.id), { command: String(input?.command ?? ""), name });
        }
        if (typeof input?.command === "string") {
          harvestToolOutput(acc, input.command, ts, { command: input.command, name });
        }
      }
    }
    acc.seq += 1;
    return;
  }

  // Things typed by the human carry promptSource/origin. Everything else on a `user`
  // record is machinery: tool results, skill injections (isMeta + sourceToolUseID),
  // and slash-command wrappers that arrive as <command-name>/<local-command-stdout>.
  const isMachine =
    rec.isMeta === true ||
    rec.sourceToolUseID !== undefined ||
    rec.toolUseResult !== undefined;
  const isRealPrompt = typeof rec.promptSource === "string" || !isMachine;
  const text = blocksToText(message.content);
  if (isMachine) {
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        const b = block as Record<string, unknown>;
        if (b?.type !== "tool_result") continue;
        const invoked = typeof b.tool_use_id === "string" ? acc.toolCalls.get(b.tool_use_id) : undefined;
        harvestToolOutput(acc, blocksToText([b]), ts, invoked);
      }
    }
  } else {
    harvestRefs(acc, proseToText(message.content), ts, isRealPrompt ? "prompt" : "prose");
  }

  if (isRealPrompt && !isMachine && text.trim() && !text.startsWith("<")) {
    acc.userMessageCount += 1;
    if (!acc.firstPrompt) acc.firstPrompt = text.slice(0, 500);
    acc.turns.push({
      uuid: String(rec.uuid ?? `u${acc.seq}`),
      ts,
      role: "user",
      text: text.slice(0, 2000),
    });
  }
  acc.seq += 1;
}

export function contextWindowFor(model: string | null, observed: number): number {
  // The transcript records `claude-opus-5` with no [1m] marker even on 1M-context
  // sessions, so the window has to be inferred from what the session actually used.
  if (observed > 200_000) return 1_000_000;
  if (model?.includes("haiku")) return 200_000;
  return 200_000;
}
