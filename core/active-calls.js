import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STATE_DIR = path.resolve(process.env.VALEY_STATE_DIR || "state");
const ACTIVE_CALLS_FILE = path.join(STATE_DIR, "active-calls.json");
const MAX_HISTORY = 10;

export async function recordActiveCall(callSid, briefing, context = {}) {
  const calls = await readActiveCalls();
  calls[String(callSid)] = {
    callSid: String(callSid),
    briefing: String(briefing || ""),
    context,
    history: [],
    exchangeCount: 0,
    pendingAction: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await writeActiveCalls(calls);
  return calls[String(callSid)];
}

export async function getActiveCall(callSid) {
  const calls = await readActiveCalls();
  return calls[String(callSid)] || null;
}

export async function appendCallTurn(callSid, userText, assistantText) {
  const calls = await readActiveCalls();
  const call = calls[String(callSid)];

  if (!call) {
    return null;
  }

  call.history = [
    ...(call.history || []),
    {
      userText: String(userText || ""),
      assistantText: String(assistantText || ""),
      at: new Date().toISOString()
    }
  ].slice(-MAX_HISTORY);
  call.exchangeCount = (call.exchangeCount || 0) + 1;
  call.updatedAt = new Date().toISOString();
  await writeActiveCalls(calls);
  return call;
}

export async function setCallPendingAction(callSid, pendingAction) {
  const calls = await readActiveCalls();
  const call = calls[String(callSid)];

  if (!call) {
    return null;
  }

  call.pendingAction = pendingAction ? {
    action: pendingAction.action,
    speak: String(pendingAction.speak || ""),
    createdAt: new Date().toISOString()
  } : null;
  call.updatedAt = new Date().toISOString();
  await writeActiveCalls(calls);
  return call;
}

async function readActiveCalls() {
  try {
    const content = await readFile(ACTIVE_CALLS_FILE, "utf8");
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

async function writeActiveCalls(calls) {
  await mkdir(STATE_DIR, { recursive: true });
  const tempFile = path.join(STATE_DIR, `active-calls.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tempFile, `${JSON.stringify(calls, null, 2)}\n`, "utf8");
  await rename(tempFile, ACTIVE_CALLS_FILE);
}

async function runSelfTest() {
  await recordActiveCall("CA_TEST", "Briefing text", { eventId: "event-1" });
  let call;

  for (let index = 0; index < 12; index += 1) {
    call = await appendCallTurn("CA_TEST", `turn ${index}`, "I can help with that.");
  }

  const loaded = await getActiveCall("CA_TEST");
  await setCallPendingAction("CA_TEST", { speak: "Draft an email.", action: { type: "draft_email", payload: {} } });
  const withPending = await getActiveCall("CA_TEST");
  await setCallPendingAction("CA_TEST", null);
  const cleared = await getActiveCall("CA_TEST");
  const passed = loaded?.briefing === "Briefing text" && call?.history?.length === 10 && call?.exchangeCount === 12 &&
    withPending?.pendingAction?.action?.type === "draft_email" && cleared?.pendingAction === null;

  console.log(`${passed ? "PASS" : "FAIL"} active call store`);

  if (!passed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runSelfTest().catch((error) => {
    console.error(`FAIL active call store: ${error.message}`);
    process.exitCode = 1;
  });
}
