import "dotenv/config";
import { fileURLToPath } from "node:url";
import { subscribe } from "./core/bus.js";
import { decide } from "./core/decide.js";
import { createPendingApproval, consumePendingApproval, expirePendingApprovals } from "./core/approvals.js";
import { recordResponse } from "./core/memory.js";
import { isFinancial } from "./core/redact.js";
import { createEvent } from "./adapters/out/calendar.js";
import { createDraft } from "./adapters/out/email.js";
import { placeCall } from "./adapters/out/call.js";
import { sendSms } from "./adapters/out/sms.js";

const INBOUND_ADAPTERS = [
  {
    name: "telegram",
    path: "./adapters/in/telegram.js",
    requiredEnv: ["TELEGRAM_BOT_TOKEN"]
  },
  {
    name: "discord",
    path: "./adapters/in/discord.js",
    requiredEnv: ["DISCORD_BOT_TOKEN"]
  },
  {
    name: "gmail",
    path: "./adapters/in/gmail.js",
    requiredEnv: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"]
  },
  {
    name: "calendar",
    path: "./adapters/in/calendar.js",
    requiredEnv: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"]
  }
];

const startedAdapters = [];

export function subscribeToEvents() {
  return subscribe(async (event) => {
    try {
      await handleEvent(event);
    } catch (error) {
      console.error(`Failed to handle event ${event.id}: ${error.message}`);
    }
  });
}

export async function handleEvent(event) {
  await expirePendingApprovals();

  if (event.source === "telegram") {
    const approval = await consumePendingApproval(event.text);

    if (approval) {
      const result = await executeApprovedAction(approval);
      await recordResponse(approval.decisionId, result.ok ? "approved" : "ignored");
      await sendTelegramMessage(result.ok ? `Approved ${approval.code}. Action executed.` : `Approval ${approval.code} failed: ${result.error?.message || "unknown error"}`);
      console.log(`Executed approval ${approval.code} for ${approval.eventId}: ${result.ok ? "ok" : result.error?.message || "failed"}`);
      return result;
    }
  }

  const decision = await decide(event);
  return dispatchDecision(event, decision);
}

export async function dispatchDecision(event, decision) {
  decision = enforceFinancialSafety(event, decision);

  if (decision.proposedAction && decision.requiresApproval) {
    const approval = await createPendingApproval(decision);
    return dispatchApprovalRequest(event, decision, approval);
  }

  return dispatchNotification(decision);
}

export function enforceFinancialSafety(event, decision) {
  if (!isFinancial(event.text)) {
    return decision;
  }

  return {
    ...decision,
    tier: "low",
    channel: "log",
    reason: "Sensitive financial, OTP, or security content was withheld and logged only.",
    proposedAction: null,
    requiresApproval: false
  };
}

async function dispatchApprovalRequest(event, decision, approval) {
  const message = approvalText(decision, approval);

  if (decision.channel === "voice") {
    const result = await sendVoice(buildVoiceSpokenText(decision, approval));
    logDispatchResult("voice approval", result);
    return result;
  }

  if (decision.channel === "sms") {
    const result = await sendSms(message);
    logDispatchResult("sms", result);
    return result;
  }

  if (event.source === "telegram") {
    const result = await sendTelegramMessage(message);
    logDispatchResult("telegram approval", result);
    return result;
  }

  if (decision.channel === "call") {
    const result = await placeCall(callScript(decision, approval));
    logDispatchResult("call", result);
    return result;
  }

  console.log(`Pending approval ${approval.code} for ${decision.eventId}: ${decision.proposedAction.summary}`);
  return { ok: true };
}

async function dispatchNotification(decision) {
  if (decision.channel === "call") {
    const result = await placeCall(callScript(decision));
    logDispatchResult("call", result);
    return result;
  }

  if (decision.channel === "sms") {
    const result = await sendSms(notificationText(decision));
    logDispatchResult("sms", result);
    return result;
  }

  if (decision.channel === "voice") {
    const result = await sendVoice(buildVoiceSpokenText(decision));
    logDispatchResult("voice", result);
    return result;
  }

  console.log(`Logged ${decision.tier} event ${decision.eventId}: ${decision.reason}`);
  return { ok: true };
}

async function executeApprovedAction(approval) {
  if (!approval?.action) {
    return { ok: false, error: { message: "No approved action was stored." } };
  }

  console.log(`Executing approved action ${approval.code}: ${approval.action.type}`);

  if (approval.action.type === "email_reply") {
    return createDraft(approval.action.payload);
  }

  if (approval.action.type === "calendar_event") {
    return createEvent(approval.action.payload);
  }

  console.log(`No executor is available for ${approval.action.type}; falling back to log channel.`);
  return { ok: true, degraded: true, path: "log" };
}

async function sendVoice(text) {
  try {
    const voice = await import("./adapters/out/voice.js");

    if (typeof voice.sendVoiceNote !== "function") {
      console.log("Voice adapter is missing sendVoiceNote(); falling back to log channel.");
      console.log(`Voice fallback text: ${text}`);
      return { ok: true, degraded: true, path: "log" };
    }

    console.log("Dispatching via voice adapter sendVoiceNote().");
    const result = await voice.sendVoiceNote(text);
    return result?.ok || result?.degraded ? { ...result, ok: true } : result;
  } catch (error) {
    console.log(`Voice dispatch failed before delivery; falling back to log channel: ${error.message}`);
    console.log(`Voice fallback text: ${text}`);
    return { ok: true, degraded: true, path: "log" };
  }
}

async function sendTelegramMessage(text) {
  try {
    const telegram = await import("./adapters/in/telegram.js");

    if (typeof telegram.sendMessage !== "function") {
      console.log("Telegram sendMessage() is unavailable; falling back to log channel.");
      console.log(`Telegram fallback text: ${text}`);
      return { ok: true, degraded: true, path: "log" };
    }

    console.log("Dispatching via Telegram sendMessage().");
    return telegram.sendMessage(text);
  } catch (error) {
    console.log(`Telegram dispatch failed before delivery; falling back to log channel: ${error.message}`);
    console.log(`Telegram fallback text: ${text}`);
    return { ok: true, degraded: true, path: "log" };
  }
}

async function startConfiguredAdapters() {
  for (const adapterConfig of INBOUND_ADAPTERS) {
    const missing = adapterConfig.requiredEnv.filter((name) => !process.env[name]);

    if (missing.length > 0) {
      console.log(`Skipping ${adapterConfig.name}: missing ${missing.join(", ")}.`);
      continue;
    }

    const adapter = await import(adapterConfig.path);

    if (typeof adapter.start !== "function") {
      console.log(`Skipping ${adapterConfig.name}: adapter start() is not implemented yet.`);
      continue;
    }

    await adapter.start();
    startedAdapters.push({ name: adapterConfig.name, stop: adapter.stop });
    console.log(`Started ${adapterConfig.name}.`);
  }

  if (startedAdapters.length === 0) {
    console.log("Valey started with no inbound adapters active.");
  }
}

async function stopAdapters() {
  for (const adapter of startedAdapters.reverse()) {
    if (typeof adapter.stop !== "function") {
      continue;
    }

    try {
      await adapter.stop();
      console.log(`Stopped ${adapter.name}.`);
    } catch (error) {
      console.error(`Failed to stop ${adapter.name}: ${error.message}`);
    }
  }
}

function callScript(decision, approval = null) {
  const action = decision.proposedAction && approval ? ` Proposed action: ${decision.proposedAction.summary}. Reply ${approval.code} to approve.` : " Reply approve if you want Valey to draft the next step.";
  return `Valey found a critical item. ${decision.reason}.${action}`;
}

function notificationText(decision) {
  const action = decision.proposedAction ? ` Proposed action: ${decision.proposedAction.summary}. Approval required.` : "";
  return `Valey ${decision.tier}: ${decision.reason}.${action}`;
}

export function buildVoiceSpokenText(decision, approval = null) {
  if (decision.proposedAction && approval) {
    return `Valey says: ${decision.reason}. Proposed action: ${decision.proposedAction.summary}. Reply with code ${approval.code} to approve.`;
  }

  return `Valey says: ${decision.reason}`;
}

function approvalText(decision, approval) {
  return `Valey needs approval: ${decision.proposedAction.summary}. Reply ${approval.code} to approve.`;
}

function logDispatchResult(channel, result) {
  if (result?.ok || result?.degraded) {
    const path = result?.degraded ? ` with ${result.path || "degraded"} fallback` : "";
    console.log(`Dispatched ${channel} notification${path}.`);
    return;
  }

  console.error(`Failed to dispatch ${channel} notification: ${result.error?.message || "unknown error"}`);
}

async function run() {
  subscribeToEvents();
  await startConfiguredAdapters();

  process.on("SIGINT", async () => {
    console.log("Stopping Valey...");
    await stopAdapters();
    process.exit(0);
  });
}

async function runSelfTest() {
  const decision = {
    eventId: "gmail:approval-test",
    tier: "high",
    reason: "A reply is needed today.",
    channel: "sms",
    memoryId: "decision-test",
    proposedAction: {
      type: "calendar_event",
      summary: "Create a short follow-up.",
      payload: {
        summary: "Follow-up",
        start: "2026-09-12T10:00:00.000Z",
        end: "2026-09-12T10:30:00.000Z",
        description: "Follow-up"
      }
    },
    requiresApproval: true
  };
  const approval = await createPendingApproval(decision);
  const consumed = await consumePendingApproval(approval.code);
  const missed = await consumePendingApproval("A99");
  const voiceText = buildVoiceSpokenText({ ...decision, channel: "voice" }, approval);
  const passed = consumed?.action?.type === "calendar_event" && missed === null && voiceText.includes(approval.code) && voiceText.includes(decision.reason) && voiceText.includes(decision.proposedAction.summary);

  console.log(`${passed ? "PASS" : "FAIL"} index approval gating`);

  if (!passed) {
    process.exitCode = 1;
  }
}

function runSafetySelfTest() {
  const event = {
    id: "gmail:otp-test",
    text: "Your OTP is 123456 for payment approval."
  };
  const unsafeDecision = {
    eventId: event.id,
    tier: "critical",
    reason: "This would normally call.",
    channel: "call",
    proposedAction: {
      type: "message_reply",
      summary: "Reply with the code.",
      payload: {}
    },
    requiresApproval: true
  };
  const safeDecision = enforceFinancialSafety(event, unsafeDecision);
  const passed = safeDecision.channel === "log" && safeDecision.proposedAction === null && safeDecision.requiresApproval === false;

  console.log(`${passed ? "PASS" : "FAIL"} otp dispatch safety`);

  if (!passed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.env.VALEY_SELF_TEST === "approval") {
    await runSelfTest();
    process.exit(process.exitCode || 0);
  }

  if (process.env.VALEY_SELF_TEST === "safety") {
    runSafetySelfTest();
    process.exit(process.exitCode || 0);
  }

  await run();
}
