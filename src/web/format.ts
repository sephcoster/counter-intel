export function relativeTime(iso: string | null): string {
  if (!iso) return "unknown";
  const delta = Date.now() - Date.parse(iso);
  if (!Number.isFinite(delta)) return "unknown";
  const s = Math.max(0, Math.round(delta / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function shortenPath(p: string | null): string {
  if (!p) return "—";
  return p.replace(/^\/Users\/[^/]+/, "~");
}

export function prUrl(value: string): string {
  const [repo, num] = value.split("#");
  return `https://github.com/${repo}/pull/${num}`;
}

export function linearUrl(key: string): string {
  return `https://linear.app/issue/${key}`;
}
