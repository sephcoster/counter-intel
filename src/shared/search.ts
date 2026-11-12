import type { SessionSummary } from "./types.js";
import { PROVIDER_LABEL } from "./provider.js";

export function prNumberQuery(query: string): string | null {
  const q = query.trim();
  const match = /^(?:(?:pr|pull request)\s*)?#?\s*(\d+)$/i.exec(q)
    ?? /^https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)\/?$/i.exec(q)
    ?? /^[\w.-]+\/[\w.-]+#(\d+)$/.exec(q);
  return match ? match[1].replace(/^0+(?=\d)/, "") : null;
}

export function matchesSessionQuery(session: SessionSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const metadata = [PROVIDER_LABEL[session.provider], session.title, session.firstPrompt,
    session.projectName, session.gitBranch, session.cwd, session.lastPrompt];
  const number = prNumberQuery(q);
  if (number) {
    // Qualified references must retain their repository, since numbers overlap.
    const qualified = /^(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+)(?:#|\/pull\/)/i.exec(q);
    if (qualified) return session.refs.some((r) => r.kind === "pr" && r.value.toLowerCase() === `${qualified[1]}#${number}`);
    return (session.prNumbers ?? []).includes(number) ||
      session.refs.some((r) => r.kind === "pr" && r.value.split("#")[1] === number) ||
      metadata.some((v) => v && new RegExp(`\\b${number}\\b`).test(v));
  }
  return [...metadata, ...session.refs.map((r) => r.value)]
    .some((value) => value?.toLowerCase().includes(q));
}

export function withinSessionScope(session: SessionSummary, scope: "active" | "recent" | "all", query: string, now = Date.now()): boolean {
  if (session.isLive) return true;
  if (scope === "active") return false;
  if (scope === "all" || prNumberQuery(query) !== null) return true;
  return session.updatedAt !== null && now - Date.parse(session.updatedAt) < 7 * 86_400_000;
}
