import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { indexAll } from "./indexer.js";
import { ingestHookEvents } from "./ingest.js";
import { listSessions, getSession } from "./status.js";
import { clearRepoCache } from "./git.js";
import { refsNeedReindex } from "./db.js";
import { focusTty, attachTmuxPane } from "./focus.js";
import {
  runOnce, openFindings, startScheduler, restartScheduler,
  dismissFinding, dismissUnactionable, nudgeFinding,
} from "./supervisor/index.js";
import { loadSupervisorConfig, saveSupervisorConfig } from "./supervisor/config.js";
import { recentNudges } from "./supervisor/nudge.js";

const PORT = Number(process.env.PORT ?? 4317);
const HOST = process.env.HOST ?? "127.0.0.1";
const TRANSCRIPT_INTERVAL_MS = 5_000;
const EVENT_INTERVAL_MS = 2_000;

const app = Fastify({ logger: false });

app.get("/api/health", async () => ({ ok: true, uptime: process.uptime() }));

app.get("/api/sessions", async (req) => {
  const q = req.query as Record<string, string | undefined>;
  const includeSidechains = q.includeSidechains === "1" || q.includeSidechains === "true";
  const sessions = listSessions(includeSidechains);
  return { sessions, generatedAt: new Date().toISOString() };
});

app.get("/api/sessions/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const detail = getSession(id);
  if (!detail) return reply.code(404).send({ error: "unknown session" });
  return detail;
});

app.post("/api/sessions/:id/focus", async (req, reply) => {
  const { id } = req.params as { id: string };
  const detail = getSession(id);
  if (!detail) return reply.code(404).send({ error: "unknown session" });
  const result = await focusTty(detail.tty);
  return reply.code(result.ok ? 200 : 409).send(result);
});

app.post("/api/sessions/:id/tmux-attach", async (req, reply) => {
  const { id } = req.params as { id: string };
  const detail = getSession(id);
  if (!detail) return reply.code(404).send({ error: "unknown session" });
  const result = await attachTmuxPane(detail.tty);
  return reply.code(result.ok ? 200 : 409).send(result);
});

app.get("/api/supervisor", async () => ({
  config: loadSupervisorConfig(),
  findings: openFindings(),
  nudges: recentNudges(30),
}));

app.patch("/api/supervisor/config", async (req) => {
  const config = saveSupervisorConfig(req.body as Record<string, unknown>);
  restartScheduler();
  return config;
});

app.post("/api/supervisor/run", async (req) => {
  const q = req.query as Record<string, string | undefined>;
  return runOnce({ force: q.force === "1" || q.force === "true" });
});

app.post("/api/supervisor/findings/:id/dismiss", async (req, reply) => {
  const { id } = req.params as { id: string };
  const ok = dismissFinding(Number(id));
  return ok ? { ok } : reply.code(404).send({ error: "unknown finding" });
});

app.post("/api/supervisor/findings/:id/nudge", async (req) => {
  const { id } = req.params as { id: string };
  return nudgeFinding(Number(id));
});

app.post("/api/supervisor/dismiss-unactionable", async () => ({
  dismissed: dismissUnactionable(),
}));

app.post("/api/refresh", async (req) => {
  const q = req.query as Record<string, string | undefined>;
  const force = q.force === "1" || q.force === "true";
  if (force) clearRepoCache();
  ingestHookEvents();
  const result = indexAll(force);
  return result;
});

const webDist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "web");
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
    return reply.sendFile("index.html");
  });
}

const boot = indexAll(refsNeedReindex);
console.log(
  `[counter-intel] indexed ${boot.updated}/${boot.scanned} transcripts ` +
    `(${(boot.bytesRead / 1024 / 1024).toFixed(1)} MB) in ${boot.ms}ms`,
);
ingestHookEvents();
startScheduler();

setInterval(() => {
  try {
    indexAll();
  } catch (err) {
    console.error("[counter-intel] index error", err);
  }
}, TRANSCRIPT_INTERVAL_MS).unref();

setInterval(() => {
  try {
    ingestHookEvents();
  } catch (err) {
    console.error("[counter-intel] ingest error", err);
  }
}, EVENT_INTERVAL_MS).unref();

await app.listen({ port: PORT, host: HOST });
console.log(`[counter-intel] api on http://${HOST}:${PORT}`);
