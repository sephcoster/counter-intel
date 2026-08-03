#!/usr/bin/env node
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(HERE, "..", "hooks", "counter-intel-hook.sh");
const CLAUDE_DIR = join(homedir(), ".claude");
const SETTINGS = join(CLAUDE_DIR, "settings.json");
const TARGET_DIR = join(CLAUDE_DIR, "hooks", "counter-intel");
const TARGET = join(TARGET_DIR, "counter-intel-hook.sh");

const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "Notification",
  "PermissionRequest",
  "SessionEnd",
  "PreCompact",
  "SubagentStart",
];

const uninstall = process.argv.includes("--uninstall");

if (!existsSync(SETTINGS)) {
  console.error(`No settings file at ${SETTINGS}`);
  process.exit(1);
}

const backup = `${SETTINGS}.counter-intel-backup-${Date.now()}`;
copyFileSync(SETTINGS, backup);
console.log(`Backed up settings to ${backup}`);

const settings = JSON.parse(readFileSync(SETTINGS, "utf8"));
settings.hooks ??= {};

let changed = 0;

for (const event of EVENTS) {
  const matchers = (settings.hooks[event] ??= []);
  // Drop any prior install first so re-running is idempotent.
  for (const matcher of matchers) {
    if (!Array.isArray(matcher.hooks)) continue;
    const before = matcher.hooks.length;
    matcher.hooks = matcher.hooks.filter((h) => !String(h?.command ?? "").includes("counter-intel-hook"));
    changed += before - matcher.hooks.length;
  }
  settings.hooks[event] = matchers.filter((m) => !Array.isArray(m.hooks) || m.hooks.length > 0);

  if (uninstall) continue;

  const entry = { type: "command", command: TARGET };
  const existing = settings.hooks[event].find((m) => !m.matcher || m.matcher === "*");
  if (existing) {
    existing.hooks ??= [];
    existing.hooks.push(entry);
  } else {
    settings.hooks[event].push({ hooks: [entry] });
  }
  changed += 1;
}

if (!uninstall) {
  mkdirSync(TARGET_DIR, { recursive: true });
  copyFileSync(SOURCE, TARGET);
  chmodSync(TARGET, 0o755);
  console.log(`Installed hook script at ${TARGET}`);
}

writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
console.log(
  uninstall
    ? `Removed counter-intel from ${changed} hook slot(s).`
    : `Registered counter-intel on ${EVENTS.length} events (${changed} slot changes).`,
);
console.log("Existing hooks were preserved. Restart Claude sessions to pick up the change.");
