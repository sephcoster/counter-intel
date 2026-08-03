import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, basename } from "node:path";

export interface RepoInfo {
  root: string | null;
  isWorktree: boolean;
  worktreeOf: string | null;
}

const cache = new Map<string, RepoInfo>();

function findGitEntry(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 40; i += 1) {
    const candidate = join(dir, ".git");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function repoInfo(cwd: string | null): RepoInfo {
  if (!cwd) return { root: null, isWorktree: false, worktreeOf: null };
  const cached = cache.get(cwd);
  if (cached) return cached;

  let info: RepoInfo = { root: null, isWorktree: false, worktreeOf: null };
  try {
    const gitEntry = findGitEntry(cwd);
    if (gitEntry) {
      const root = dirname(gitEntry);
      // A linked worktree has `.git` as a file containing `gitdir: <main>/.git/worktrees/<name>`.
      if (statSync(gitEntry).isFile()) {
        const contents = readFileSync(gitEntry, "utf8").trim();
        const match = /^gitdir:\s*(.+)$/m.exec(contents);
        const gitdir = match?.[1]?.trim() ?? null;
        const wtMatch = gitdir ? /^(.*)\/\.git\/worktrees\/[^/]+$/.exec(gitdir) : null;
        info = { root, isWorktree: true, worktreeOf: wtMatch?.[1] ?? null };
      } else {
        info = { root, isWorktree: false, worktreeOf: null };
      }
    }
  } catch {
    /* unreadable path */
  }

  cache.set(cwd, info);
  return info;
}

export function projectName(cwd: string | null, projectDir: string): string {
  if (cwd) {
    const info = repoInfo(cwd);
    if (info.root) {
      const root = basename(info.root);
      const sub = cwd.startsWith(info.root) ? cwd.slice(info.root.length).replace(/^\//, "") : "";
      return sub ? `${root}/${sub}` : root;
    }
    return basename(cwd);
  }
  return projectDir.replace(/^-/, "").replace(/-/g, "/");
}

export function clearRepoCache(): void {
  cache.clear();
}
