import { fileURLToPath } from "node:url";
import { classify } from "./classify.js";
import { validateDecision } from "./events.js";
import { getCallsInLastHour, recordDecision } from "./memory.js";

const CHANNEL_BY_TIER = {
  critical: "call",
  high: "sms",
  normal: "voice",
  low: "log"
};

const OVERRIDE_PATTERN = /\b(deadline|payment failure|security alert)\b/i;

export async function decide(event) {
  const classification = await classify(event);
  let channel = CHANNEL_BY_TIER[classification.tier] || "log";
  let reason = classification.reason;

  if (classification.tier === "critical" && channel === "call") {
    const callsInLastHour = await getCallsInLastHour();
    const override = isOverrideEvent(event, classification);
    const limitHit = override ? callsInLastHour >= 3 : callsInLastHour >= 2;

    if (limitHit) {
      channel = "sms";
      reason = `${reason} Call rate limit reached, so Valey downgraded this alert to SMS.`;
    }
  }

  const proposedAction = classification.suggestedAction
    ? {
        type: classification.suggestedAction.type,
        summary: classification.suggestedAction.summary,
        payload: classification.suggestedAction.payload
      }
    : null;

  const decision = {
    eventId: event.id,
    tier: classification.tier,
    reason,
    channel,
    proposedAction,
    requiresApproval: proposedAction !== null,
    category: classification.category || "general"
  };

  const validation = validateDecision(decision);

  if (!validation.valid) {
    console.error(`Invalid decision: ${validation.errors.join(" ")}`);
    const fallback = {
      eventId: event.id,
      tier: "low",
      reason: "Decision validation failed, so Valey logged the event only.",
      channel: "log",
      proposedAction: null,
      requiresApproval: false,
      category: "validation"
    };
    await recordDecision(event, fallback);
    return fallback;
  }

  await recordDecision(event, decision);
  return decision;
}

function isOverrideEvent(event, classification) {
  const category = classification.category || "";
  const reason = classification.reason || "";
  const text = event.text || "";
  return OVERRIDE_PATTERN.test(category) || OVERRIDE_PATTERN.test(reason) || OVERRIDE_PATTERN.test(text);
}

async function runSelfTest() {
  const event = {
    id: "gmail:msg-3",
    source: "gmail",
    sourceMessageId: "msg-3",
    threadId: null,
    author: { id: "sender", displayName: "Sender" },
    text: "Please review this when you can.",
    receivedAt: "2026-09-12T08:42:00.000Z",
    meta: {}
  };
  const decision = await decide(event);
  const validation = validateDecision(decision);
  const passed = validation.valid && decision.channel === "voice" && decision.requiresApproval === false;

  console.log(`${passed ? "PASS" : "FAIL"} decision fallback path`);

  if (!passed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runSelfTest().catch((error) => {
    console.error(`FAIL decision fallback path: ${error.message}`);
    process.exitCode = 1;
  });
}
