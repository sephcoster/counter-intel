import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export interface CoreHours {
  start: string;
  end: string;
  days: number[];
  timezone: string;
}

export interface SupervisorConfig {
  enabled: boolean;
  /** When true, nudges are drafted and logged but never injected. */
  dryRun: boolean;
  intervalMinutes: number;
  coreHours: CoreHours;
  /** A session can't be nudged again until this many hours have passed. */
  minNudgeIntervalHours: number;
  /** Hard ceiling per run, so a bad scan can't spray every terminal at once. */
  maxNudgesPerRun: number;
  /** Only these statuses may receive an injection. */
  nudgeableStatuses: string[];
  model: string;
  idleHoursBeforeStuck: number;
  /** Sessions untouched for longer than this are considered finished, not stalled. */
  maxSessionAgeHours: number;
  repos: string[];
}

const CONFIG_DIR = process.env.COUNTER_INTEL_HOME ?? join(homedir(), ".claude", "counter-intel");
const CONFIG_PATH = join(CONFIG_DIR, "supervisor.json");

const DEFAULTS: SupervisorConfig = {
  enabled: false,
  dryRun: true,
  intervalMinutes: 45,
  coreHours: { start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5], timezone: "America/New_York" },
  minNudgeIntervalHours: 4,
  maxNudgesPerRun: 3,
  // "waiting" means the Stop hook fired: Claude finished its turn and the terminal
  // is at a prompt. Never include "blocked" — text sent to a permission prompt
  // answers it.
  nudgeableStatuses: ["waiting"],
  model: "claude-sonnet-5",
  idleHoursBeforeStuck: 3,
  maxSessionAgeHours: 72,
  repos: [],
};

let cached: SupervisorConfig | null = null;

export function loadSupervisorConfig(): SupervisorConfig {
  if (cached) return cached;
  try {
    if (existsSync(CONFIG_PATH)) {
      const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<SupervisorConfig>;
      cached = { ...DEFAULTS, ...parsed, coreHours: { ...DEFAULTS.coreHours, ...parsed.coreHours } };
      // A config that widens the guard past "waiting" is treated as a mistake, not intent.
      cached.nudgeableStatuses = cached.nudgeableStatuses.filter((s) => s === "waiting" || s === "idle");
      if (cached.nudgeableStatuses.length === 0) cached.nudgeableStatuses = ["waiting"];
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

export function reloadSupervisorConfig(): SupervisorConfig {
  cached = null;
  return loadSupervisorConfig();
}

export function saveSupervisorConfig(patch: Partial<SupervisorConfig>): SupervisorConfig {
  const next = { ...loadSupervisorConfig(), ...patch };
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`);
  cached = null;
  return loadSupervisorConfig();
}

function minutesInZone(now: Date, timezone: string): { minutes: number; day: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour ?? 0) % 24;
  const minute = Number(parts.minute ?? 0);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return { minutes: hour * 60 + minute, day: days.indexOf(String(parts.weekday)) };
}

function parseHm(hm: string): number {
  const [h, m] = hm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function withinCoreHours(config: SupervisorConfig, now = new Date()): boolean {
  const { minutes, day } = minutesInZone(now, config.coreHours.timezone);
  if (day < 0 || !config.coreHours.days.includes(day)) return false;
  const start = parseHm(config.coreHours.start);
  const end = parseHm(config.coreHours.end);
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

export { CONFIG_PATH as SUPERVISOR_CONFIG_PATH };
