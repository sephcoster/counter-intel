import assert from "node:assert/strict";
import { test } from "node:test";
import { focusEmulatorTab } from "../src/server/focus.js";

test("an iTerm timeout reports failure without trying Terminal or claiming an app raise succeeded", async () => {
  let calls = 0;
  const result = await focusEmulatorTab("/dev/ttys005", {
    appForTty: async () => ({ name: "iTerm", bundle: "/Applications/iTerm.app" }),
    tryScript: async () => { calls++; return "timeout"; },
    activateApp: async () => { assert.fail("must not mask a failed tab jump"); },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "timeout");
  assert.equal(calls, 1);
});

test("a missing iTerm tab stays a failure", async () => {
  const result = await focusEmulatorTab("/dev/ttys005", {
    appForTty: async () => ({ name: "iTerm", bundle: "/Applications/iTerm.app" }),
    tryScript: async () => "notfound",
    activateApp: async () => { assert.fail("must not mask a missing tab"); },
  });
  assert.deepEqual(result, { ok: false, reason: "not-found" });
});

test("Terminal owners bypass iTerm; unknown owners still use the fallback", async () => {
  const calls: string[] = [];
  const deps = {
    appForTty: async () => ({ name: "Terminal", bundle: "/System/Applications/Utilities/Terminal.app" }),
    tryScript: async (script: string) => { calls.push(script); return "ok"; },
    activateApp: async () => false,
  };
  assert.deepEqual(await focusEmulatorTab("/dev/ttys005", deps), { ok: true, app: "Terminal", via: "tab" });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('tell application "Terminal"'));
  assert.deepEqual(await focusEmulatorTab("/dev/ttys005", {
    ...deps, appForTty: async () => null,
    tryScript: async (script) => script.includes('tell application "iTerm2"') ? "notrunning" : "ok",
  }), { ok: true, app: "Terminal", via: "tab" });
});

test("unsupported terminal apps are raised without AppleScript probes", async () => {
  assert.deepEqual(await focusEmulatorTab("/dev/ttys005", {
    appForTty: async () => ({ name: "Alacritty", bundle: "/Applications/Alacritty.app" }),
    tryScript: async () => { assert.fail("unsupported app should not probe unrelated terminals"); },
    activateApp: async () => true,
  }), { ok: true, app: "Alacritty", via: "app" });
});
