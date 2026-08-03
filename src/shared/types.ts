export type SessionStatus =
  | "working"
  | "waiting"
  | "blocked"
  | "idle"
  | "ended";

export interface SessionRef {
  kind: "pr" | "linear" | "url";
  value: string;
  label: string;
}

export interface SessionSummary {
  sessionId: string;
  title: string | null;
  cwd: string | null;
  projectName: string;
  gitBranch: string | null;
  isWorktree: boolean;
  worktreeOf: string | null;
  status: SessionStatus;
  statusSource: "hook" | "process" | "mtime";
  pid: number | null;
  tty: string | null;
  canFocus: boolean;
  model: string | null;
  contextTokens: number;
  contextWindow: number;
  contextPct: number;
  messageCount: number;
  userMessageCount: number;
  createdAt: string | null;
  updatedAt: string | null;
  lastPrompt: string | null;
  firstPrompt: string | null;
  permissionMode: string | null;
  isSidechain: boolean;
  refs: SessionRef[];
  transcriptPath: string;
  sizeBytes: number;
}

export interface SessionDetail extends SessionSummary {
  turns: Turn[];
  files: TouchedFile[];
  recentEvents: HookEvent[];
}

export interface Turn {
  uuid: string;
  ts: string;
  role: "user" | "assistant";
  text: string;
}

export interface TouchedFile {
  path: string;
  count: number;
  lastSeen: string;
}

export interface HookEvent {
  event: string;
  ts: string;
  cwd: string | null;
}
