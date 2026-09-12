import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STATE_DIR = path.resolve(process.env.VALEY_STATE_DIR || "state");
const PENDING_FILE = path.join(STATE_DIR, "pending.json");
const APPROVAL_TTL_MS = 30 * 60 * 1000;

export async function createPendingApproval(decision) {
  const pending = await readPending();
  const cleaned = dropExpired(pending);
  const code = nextCode(cleaned);
  const now = Date.now();

  cleaned[code] = {
    code,
    decisionId: decision.memoryId,
    eventId: decision.eventId,
    action: decision.proposedAction,
    channel: decision.channel,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + APPROVAL_TTL_MS).toISOString()
  };

  await writePending(cleaned);
  return cleaned[code];
}

export async function consumePendingApproval(code) {
  const pending = await readPending();
  const normalized = String(code || "").trim().toUpperCase();
  const cleaned = dropExpired(pending);
  const approval = cleaned[normalized];

  if (!approval) {
    await writePending(cleaned);
    return null;
  }

  delete cleaned[normalized];
  await writePending(cleaned);
  return approval;
}

export async function expirePendingApprovals() {
  const pending = await readPending();
  const cleaned = dropExpired(pending);
  await writePending(cleaned);
  return cleaned;
}

function nextCode(pending) {
  for (let index = 1; index <= 99; index += 1) {
    const code = `A${index}`;

    if (!pending[code]) {
      return code;
    }
  }

  throw new Error("No approval codes available.");
}

function dropExpired(pending) {
  const now = Date.now();
  return Object.fromEntries(
    Object.entries(pending).filter(([, approval]) => {
      const expiresAt = Date.parse(approval.expiresAt);
      return Number.isFinite(expiresAt) && expiresAt > now;
    })
  );
}

async function readPending() {
  try {
    const content = await readFile(PENDING_FILE, "utf8");
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

async function writePending(pending) {
  await mkdir(STATE_DIR, { recursive: true });
  const tempFile = path.join(STATE_DIR, `pending.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tempFile, `${JSON.stringify(pending, null, 2)}\n`, "utf8");
  await rename(tempFile, PENDING_FILE);
}

async function runSelfTest() {
  const approval = await createPendingApproval({
    memoryId: "decision-1",
    eventId: "gmail:msg-1",
    channel: "sms",
    proposedAction: { type: "message_reply", summary: "Reply yes.", payload: {} }
  });
  const consumed = await consumePendingApproval(approval.code.toLowerCase());
  const missed = await consumePendingApproval(approval.code);
  const passed = consumed?.code === approval.code && missed === null;

  console.log(`${passed ? "PASS" : "FAIL"} pending approval lifecycle`);

  if (!passed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runSelfTest().catch((error) => {
    console.error(`FAIL pending approval lifecycle: ${error.message}`);
    process.exitCode = 1;
  });
}
