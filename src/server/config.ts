import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export interface Config {
  /**
   * Linear team keys to recognize in transcript text. When non-empty this is an
   * exact allowlist — no heuristic can separate a real `SWITCH-1` ticket from the
   * grid-domain noun of the same shape, so the list has to be declared.
   * Set to [] to fall back to heuristics (hex + known-standards filtering).
   */
  linearPrefixes: string[];
}

const CONFIG_DIR = process.env.COUNTER_INTEL_HOME ?? join(homedir(), ".claude", "counter-intel");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const DEFAULTS: Config = {
  linearPrefixes: ["ALL", "BOLT", "CIR", "ENG", "XENG", "XEG", "INF", "INFR"],
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
