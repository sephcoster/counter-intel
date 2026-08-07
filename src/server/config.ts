import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export interface Config {
  /**
   * Linear team keys to recognize in transcript text, e.g. ["ENG", "PLATFORM"].
   *
   * When non-empty this is an exact allowlist. No heuristic can separate a real
   * `ORDER-1` ticket from a domain term of the same shape, so if your codebase
   * uses uppercase-dash-number identifiers for anything else, declare your team
   * keys here.
   *
   * Empty (the default) falls back to heuristics: hex fragments and known
   * standards like ISO-8601 are filtered out, everything else is accepted.
   */
  linearPrefixes: string[];
}

const CONFIG_DIR = process.env.COUNTER_INTEL_HOME ?? join(homedir(), ".claude", "counter-intel");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const DEFAULTS: Config = {
  linearPrefixes: [],
};

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  try {
    if (existsSync(CONFIG_PATH)) {
      const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
      cached = { ...DEFAULTS, ...parsed };
      return cached;
    }
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, `${JSON.stringify(DEFAULTS, null, 2)}\n`);
  } catch {
    /* fall through to defaults */
  }
  cached = DEFAULTS;
  return cached;
}

export function reloadConfig(): Config {
  cached = null;
  return loadConfig();
}

export { CONFIG_PATH };
