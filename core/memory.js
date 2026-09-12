import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redact } from "./redact.js";

const MAX_ENTRIES = 500;
const STATE_DIR = path.resolve(process.env.VALEY_STATE_DIR || "state");
const DECISIONS_FILE = path.join(STATE_DIR, "decisions.json");
const RESPONSES = new Set(["approved", "rejected", "ignored"]);

export async function recordDecision(event, decision) {
  const log = await readDecisionLog();
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    eventId: decision.eventId,
    source: event.source,
    receivedAt: event.receivedAt,
    recordedAt: new Date().toISOString(),
    redactedText: redact(event.text).clean,
    tier: decision.tier,
    reason: decision.reason,
    channel: decision.channel,
    category: decision.category || null,
    response: null,
    responseAt: null
  };

  log.push(entry);
  await writeDecisionLog(log.slice(-MAX_ENTRIES));
  return entry;
}

export async function recordResponse(decisionId, response) {
  if (!RESPONSES.has(response)) {
    throw new TypeError("response must be approved, rejected, or ignored.");
  }

  const log = await readDecisionLog();
  const entry = log.find((item) => item.id === decisionId);

  if (!entry) {
    return { ok: false, error: "decision not found" };
  }

  entry.response = response;
  entry.responseAt = new Date().toISOString();
  await writeDecisionLog(log);
  return { ok: true };
}

export async function getRecentDecisions(n = 10) {
  const limit = Math.max(0, Number.parseInt(n, 10) || 0);
  const log = await readDecisionLog();
  return log.slice(-limit).reverse();
}

export async function getCallsInLastHour() {
  const since = Date.now() - 60 * 60 * 1000;
  const log = await readDecisionLog();
  return log.filter((entry) => {
    const recordedAt = Date.parse(entry.recordedAt);
    return Number.isFinite(recordedAt) && recordedAt >= since && entry.tier === "critical" && entry.channel === "call";
  }).length;
}

export async function getDismissalCount(category) {
  const log = await readDecisionLog();
  return log.filter((entry) => entry.category === category && entry.response === "ignored").length;
}

async function readDecisionLog() {
  try {
    const content = await readFile(DECISIONS_FILE, "utf8");
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function writeDecisionLog(log) {
  await mkdir(STATE_DIR, { recursive: true });
  const tempFile = path.join(STATE_DIR, `decisions.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tempFile, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  await rename(tempFile, DECISIONS_FILE);
}

async function runSelfTest() {
  const decision = {
    eventId: "gmail:msg-1",
    tier: "critical",
    reason: "A hard deadline is due soon.",
    channel: "call",
    category: "deadline"
  };
  const event = {
    source: "gmail",
    receivedAt: "2026-09-12T08:42:00.000Z",
    text: "Email user@example.test with code 123456 before the deadline."
  };

  const entry = await recordDecision(event, decision);
  const recent = await getRecentDecisions(1);
  const response = await recordResponse(entry.id, "ignored");
  const dismissals = await getDismissalCount("deadline");
  const calls = await getCallsInLastHour();
  const redacted = !recent[0].redactedText.includes("user@example.test") && !recent[0].redactedText.includes("123456");
  const passed = response.ok && dismissals >= 1 && calls >= 1 && redacted;

  console.log(`${passed ? "PASS" : "FAIL"} memory json store`);

  if (!passed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runSelfTest().catch((error) => {
    console.error(`FAIL memory json store: ${error.message}`);
    process.exitCode = 1;
  });
}
