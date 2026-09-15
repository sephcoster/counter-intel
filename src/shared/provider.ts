import type { SessionProvider } from "./types.js";

export const PROVIDER_LABEL: Record<SessionProvider, string> = { claude: "Claude Code", codex: "Codex" };

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function resumeCommand(session: { provider: SessionProvider; sessionId: string; cwd: string | null }): string {
  const command = session.provider === "codex" ? "codex resume" : "claude --resume";
  return `cd ${shellQuote(session.cwd ?? ".")} && ${command} ${shellQuote(session.sessionId)}`;
}
