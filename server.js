import "dotenv/config";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { appendCallTurn, getActiveCall, setCallPendingAction } from "./core/active-calls.js";
import { consumePendingApproval, consumePendingApprovalForEvent } from "./core/approvals.js";
import { recordResponse } from "./core/memory.js";
import { isFinancial, redact } from "./core/redact.js";
import { createEvent, findFreeSlots } from "./adapters/out/calendar.js";
import { createDraft } from "./adapters/out/email.js";

const PORT = Number(process.env.PORT || 3000);
const DEFAULT_BRIEFING = "Valey found an urgent item that needs your attention.";
const END_INTENT_PATTERN = /\b(?:bye|goodbye|end the call|hang up|that's all|thanks that's it|cut the call|stop|done)\b/i;
const APPROVAL_PATTERN = /\b(?:yes|yeah|approve|go ahead|do it|send it|confirm|okay do that)\b/i;
const MAX_CALL_EXCHANGES = 5;
const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));
const STATE_DIR = path.resolve(process.env.VALEY_STATE_DIR || "state");
const MAX_DASHBOARD_DECISIONS = 50;
const MAX_JSON_BODY_BYTES = 4096;
const APPROVAL_CODE = /^A\d{1,2}$/;
const STATIC_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"]
};
const ADAPTER_ENV = {
  gmail: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"],
  calendar: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"],
  telegram: ["TELEGRAM_BOT_TOKEN"],
  discord: ["DISCORD_BOT_TOKEN"]
};
const TIMELINE_LENGTH = 20;
const CLEAR_SCOPES = new Set(["all", "low"]);
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SUMMARY_WORDS = 100;
const INTERNAL_REASON_PATTERNS = [
  /\bcall rate limit reached\b.*$/i,
  /\bvaley downgraded\b.*$/i,
  /\bclassifier (?:model )?(?:was unavailable|failed|returned invalid json)\b.*$/i,
  /\bfallback path\b.*$/i,
  /\bused the normal fallback\b.*$/i,
  /\bdecision validation failed\b.*$/i
];
const SUMMARY_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "before", "by", "for", "from", "has",
  "have", "in", "is", "it", "of", "on", "or", "please", "soon", "the", "this",
  "to", "was", "were", "with"
]);

function twiml(body) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}

function gatherTwiml(spokenText) {
  return twiml(`<Gather input="speech" action="/voice/reply" method="POST" speechTimeout="auto" language="en-IN"><Say voice="alice">${escapeXml(spokenText)}</Say></Gather><Say voice="alice">I did not catch that, goodbye.</Say>`);
}

function sayTwiml(spokenText) {
  return twiml(`<Say voice="alice">${escapeXml(spokenText)}</Say>`);
}

function continueTwiml(spokenText) {
  return twiml(`<Say voice="alice">${escapeXml(spokenText)}</Say><Gather input="speech" action="/voice/reply" method="POST" speechTimeout="auto" language="en-IN"><Say voice="alice">What would you like me to do next?</Say></Gather><Say voice="alice">I did not catch that, goodbye.</Say>`);
}

async function handleVoice(request, response, query) {
  try {
    const form = await readForm(request);
    const callSid = form.get("CallSid") || query.searchParams.get("callSid");
    const call = callSid ? await getActiveCall(callSid) : null;
    sendTwiML(response, gatherTwiml(safeCallBriefing(call)));
  } catch (error) {
    console.error(`Voice handler failed: ${error.message}`);
    sendTwiML(response, sayTwiml("Sorry, Valey had trouble starting this call. Goodbye."));
  }
}

async function handleVoiceReply(request, response) {
  try {
    const form = await readForm(request);
    const speech = String(form.get("SpeechResult") || "").trim();
    const callSid = form.get("CallSid");

    if (!speech || END_INTENT_PATTERN.test(speech)) {
      sendTwiML(response, sayTwiml("Okay, goodbye."));
      return;
    }

    if (!callSid) {
      sendTwiML(response, sayTwiml("Sorry, I could not identify this call. Goodbye."));
      return;
    }

    const call = await getActiveCall(callSid);

    if ((call?.exchangeCount ?? call?.history?.length ?? 0) >= MAX_CALL_EXCHANGES) {
      sendTwiML(response, sayTwiml("We have reached the conversation limit. Goodbye."));
      return;
    }

    if (isFinancial(speech)) {
      const reply = "That sounds sensitive, so I will not read or discuss it on this call.";
      await appendCallTurn(callSid, redact(speech).clean, reply);
      sendTwiML(response, continueTwiml(reply));
      return;
    }

    if (APPROVAL_PATTERN.test(speech)) {
      const approved = await executeApprovedCallAction(callSid, call);

      if (approved) {
        await appendCallTurn(callSid, redact(speech).clean, approved.speak);
        sendTwiML(response, continueTwiml(approved.speak));
        return;
      }

      const approvalDecision = await getSpokenReply(speech, call);

      if (!approvalDecision.action) {
        const reply = "I do not have anything queued to execute.";
        await appendCallTurn(callSid, redact(speech).clean, reply);
        sendTwiML(response, continueTwiml(reply));
        return;
      }

      const result = await executeCallAction(approvalDecision.action);
      const reply = callActionResultSpeech(approvalDecision.action, result);
      await appendCallTurn(callSid, redact(speech).clean, reply);
      sendTwiML(response, continueTwiml(reply));
      return;
    }

    if (call?.pendingAction) {
      const reply = `I still need a clear yes before I ${call.pendingAction.speak}.`;
      await appendCallTurn(callSid, redact(speech).clean, reply);
      sendTwiML(response, continueTwiml(reply));
      return;
    }

    const decision = await getSpokenReply(speech, call);
    let reply = decision.speak;

    if (decision.action) {
      await setCallPendingAction(callSid, {
        speak: describeCallAction(decision.action),
        action: decision.action
      });
      reply = `${reply} I can ${describeCallAction(decision.action)}. Say yes to approve.`;
    }

    await appendCallTurn(callSid, redact(speech).clean, reply);

    sendTwiML(response, continueTwiml(reply));
  } catch (error) {
    console.error(`Voice reply handler failed: ${error.message}`);
    sendTwiML(response, sayTwiml("Sorry, Valey had trouble understanding that. Goodbye."));
  }
}

async function getSpokenReply(userSpeech, call) {
  if (!process.env.OPENROUTER_API_KEY) {
    return { speak: "I heard you. Please reply in the original channel to approve any action.", action: null };
  }

  try {
    const redactedSpeech = redact(userSpeech).clean;
    const client = new OpenAI({
      baseURL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY
    });
    const completion = await client.chat.completions.create({
      model: process.env.CONVERSATION_MODEL || process.env.CLASSIFIER_MODEL || "openai/gpt-4o-mini",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: [
            "You are Valey speaking aloud on a phone call.",
            "Return strict JSON only: {\"speak\":\"under 30 words\",\"action\":null|{\"type\":\"draft_email|send_message|create_event|set_reminder|find_free_slots\",\"payload\":{}}}.",
            "Use plain conversational English, no lists, no markdown, and no URLs read aloud.",
            "Do not read out email addresses or numbers longer than four digits.",
            "State what you can do and wait.",
            "Never execute an action without explicit approval.",
            "You do not perform actions yourself. Request them with the action field, and the system will confirm afterwards.",
            "Never say sent, done, created, or scheduled in the speak field.",
            "When the user approves, return the action and let the system report the real result.",
            "Never invent details about the user's inbox or calendar that are not in the provided context."
          ].join("\n")
        },
        {
          role: "user",
          content: JSON.stringify({
            originalContext: call ? {
              briefing: safeCallBriefing(call),
              context: redactCallContext(call.context),
              history: redactHistory(call.history || [])
            } : null,
            userSpeech: redactedSpeech
          })
        }
      ]
    });
    return parseConversationResult(completion.choices?.[0]?.message?.content);
  } catch (error) {
    console.error(`Conversation model failed: ${error.message}`);
    return { speak: "I heard you, but I could not think clearly. Please reply in the original channel.", action: null };
  }
}

async function executeApprovedCallAction(callSid, call) {
  const existingApproval = call?.context?.eventId ? await consumePendingApprovalForEvent(call.context.eventId) : null;

  if (existingApproval) {
    const result = await executeCallAction(mapPendingApprovalAction(existingApproval.action));
    await safeRecordResponse(existingApproval.decisionId, result.ok ? "approved" : "ignored");
    return {
      ok: result.ok,
      speak: callActionResultSpeech(mapPendingApprovalAction(existingApproval.action), result)
    };
  }

  if (!call?.pendingAction?.action) {
    return null;
  }

  const result = await executeCallAction(call.pendingAction.action);
  await setCallPendingAction(callSid, null);
  return {
    ok: result.ok,
    speak: callActionResultSpeech(call.pendingAction.action, result)
  };
}

// The action outcome is the truth of the reply; a broken decision log must not disguise it.
async function safeRecordResponse(decisionId, value) {
  try {
    const result = await recordResponse(decisionId, value);

    if (!result.ok) {
      console.error(`Could not record ${value} for ${decisionId}: ${result.error}`);
    }
  } catch (error) {
    console.error(`Could not record ${value} for ${decisionId}: ${error.message}`);
  }
}

async function executeCallAction(action) {
  if (!action?.type) {
    return { ok: false, error: { message: "No action supplied." } };
  }

  console.log(`Executing approved call action: ${action.type}`);

  if (action.type === "draft_email") {
    return createDraft(action.payload || {});
  }

  if (action.type === "send_message") {
    return sendTelegramMessage(action.payload?.text || action.payload?.body || "");
  }

  if (action.type === "create_event") {
    return createEvent(action.payload || {});
  }

  if (action.type === "set_reminder") {
    const payload = action.payload || {};
    const start = payload.time || payload.start;
    const startMs = Date.parse(start);

    if (!Number.isFinite(startMs)) {
      return { ok: false, error: { message: "Reminder time is invalid." } };
    }

    return createEvent({
      summary: payload.summary || "Valey reminder",
      start: new Date(startMs).toISOString(),
      end: payload.end || new Date(startMs + 15 * 60 * 1000).toISOString(),
      description: payload.description || "Reminder created by Valey after spoken approval.",
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 0 }] }
    });
  }

  if (action.type === "find_free_slots") {
    const payload = action.payload || {};
    const slots = await findFreeSlots(payload.durationMinutes || 30, payload.withinHours || 8);
    return { ok: true, slots };
  }

  return { ok: false, error: { message: `Unsupported action ${action.type}.` } };
}

function parseConversationResult(content) {
  try {
    const parsed = JSON.parse(stripFences(content || ""));
    const result = {
      speak: safeSpokenText(parsed.speak || "I can help with that. What would you like me to do?"),
      action: normalizeCallAction(parsed.action)
    };
    console.log(`Parsed call action: ${JSON.stringify(result.action)}`);
    return {
      ...result,
      speak: correctCompletionClaim(result.speak, result.action)
    };
  } catch {
    console.log("Parsed call action: null");
    return { speak: "I heard you. Please say what you would like me to do next.", action: null };
  }
}

function normalizeCallAction(action) {
  const allowed = new Set(["draft_email", "send_message", "create_event", "set_reminder", "find_free_slots"]);

  if (!action || typeof action !== "object" || Array.isArray(action) || !allowed.has(action.type)) {
    return null;
  }

  return {
    type: action.type,
    payload: action.payload && typeof action.payload === "object" && !Array.isArray(action.payload) ? action.payload : {}
  };
}

function mapPendingApprovalAction(action) {
  if (!action) {
    return null;
  }

  if (action.type === "email_reply") {
    return { type: "draft_email", payload: action.payload };
  }

  if (action.type === "calendar_event") {
    return { type: "create_event", payload: action.payload };
  }

  if (action.type === "message_reply") {
    return { type: "send_message", payload: action.payload };
  }

  if (action.type === "alarm") {
    return { type: "set_reminder", payload: action.payload };
  }

  return action;
}

async function sendTelegramMessage(text) {
  try {
    const telegram = await import("./adapters/in/telegram.js");

    if (typeof telegram.sendMessage !== "function") {
      console.log("Telegram sendMessage() is unavailable; falling back to log channel.");
      console.log(`Telegram fallback text: ${text}`);
      return { ok: true, degraded: true, path: "log" };
    }

    return telegram.sendMessage(text);
  } catch (error) {
    console.log(`Telegram dispatch failed; falling back to log channel: ${error.message}`);
    console.log(`Telegram fallback text: ${text}`);
    return { ok: true, degraded: true, path: "log" };
  }
}

function safeCallBriefing(call) {
  if (!call?.briefing) {
    return DEFAULT_BRIEFING;
  }

  if (isFinancial(call.briefing)) {
    return "This item was withheld because it may contain financial or security-sensitive content.";
  }

  return safeSpokenText(call.briefing);
}

function safeSpokenText(text) {
  return limitWords(redact(String(text || "").replace(/https?:\/\/\S+/gi, "a link")).clean, 30)
    .replace(/\[EMAIL\]/g, "an email address")
    .replace(/\b\d{5,}\b/g, "a longer number");
}

function redactCallContext(context = {}) {
  return JSON.parse(JSON.stringify(context || {}), (key, value) => {
    if (typeof value !== "string") {
      return value;
    }

    return isFinancial(value) ? "[WITHHELD]" : redact(value).clean;
  });
}

function redactHistory(history) {
  return history.map((turn) => ({
    userText: redact(turn.userText || "").clean,
    assistantText: safeSpokenText(turn.assistantText || ""),
    at: turn.at
  }));
}

function stripFences(content) {
  return String(content).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function describeCallAction(action) {
  if (action.type === "draft_email") {
    return "draft the email";
  }

  if (action.type === "send_message") {
    return "send the message";
  }

  if (action.type === "create_event") {
    return "create the calendar event";
  }

  if (action.type === "set_reminder") {
    return "set the reminder";
  }

  if (action.type === "find_free_slots") {
    return "look for free times";
  }

  return "do that";
}

function pastTenseAction(action) {
  if (action.type === "draft_email") {
    return "created the draft";
  }

  if (action.type === "create_event") {
    return "created the calendar event";
  }

  if (action.type === "set_reminder") {
    return "set the reminder";
  }

  if (action.type === "send_message") {
    return "sent the message";
  }

  if (action.type === "find_free_slots") {
    return "checked the calendar";
  }

  return "completed it";
}

function callActionSuccessSpeech(action, result) {
  if (action?.type === "find_free_slots") {
    return naturalFreeSlots(result.slots || []);
  }

  return `Approved. I ${pastTenseAction(action)}.`;
}

function callActionFailureSpeech(action, result) {
  const reason = safeSpokenText(result?.error?.message || result?.error || "the adapter reported an error");
  return `I could not ${describeCallAction(action)} because ${reason}.`;
}

function callActionResultSpeech(action, result) {
  return result?.ok ? callActionSuccessSpeech(action, result) : callActionFailureSpeech(action, result);
}

function correctCompletionClaim(speak, action) {
  if (action || !/\b(?:sent|done|created|scheduled)\b/i.test(speak)) {
    return speak;
  }

  return "I do not have anything queued to execute.";
}

function naturalFreeSlots(slots) {
  if (slots.length === 0) {
    return "Approved. I checked, but I could not find a free slot.";
  }

  const times = slots.slice(0, 3).map((slot) => new Date(slot).toLocaleTimeString("en-IN", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata"
  }));
  return `Approved. I found free time at ${times.join(", ")}.`;
}

function limitWords(text, maxWords) {
  const words = String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  return words.slice(0, maxWords).join(" ") || "I heard you. What should I do next?";
}

function sendTwiML(response, body) {
  console.log("Twilio response TwiML:");
  console.log(body);
  response.writeHead(200, { "content-type": "text/xml; charset=utf-8" });
  response.end(body);
}

async function readForm(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function escapeXml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function handleStatic(response, [fileName, contentType]) {
  try {
    const body = await readFile(path.join(PUBLIC_DIR, fileName));
    response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
    response.end(body);
  } catch (error) {
    console.error(`Static file failed: ${error.message}`);
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found.");
  }
}

async function handleState(response) {
  let state;

  try {
    state = await buildDashboardState();
  } catch (error) {
    console.error(`State handler failed: ${error.message}`);
    state = summarize([], {});
  }

  response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(state));
}

// ponytail: index.js and this process both read-modify-write pending.json; move to one writer if approvals ever collide.
async function handleApproval(request, response, action) {
  try {
    const body = await readJsonBody(request);
    const code = String(body?.code || "").trim().toUpperCase();

    if (!body || !APPROVAL_CODE.test(code)) {
      sendJson(response, { ok: false, reason: "Send a JSON body with a valid approval code." });
      return;
    }

    // consumePendingApproval() drops expired records and removes this one, so nothing can run twice.
    const approval = await consumePendingApproval(code);

    if (!approval) {
      sendJson(response, { ok: false, reason: `${code} is not pending. It may have expired or already been handled.` });
      return;
    }

    if (action === "decline") {
      await safeRecordResponse(approval.decisionId, "rejected");
      sendJson(response, { ok: true });
      return;
    }

    const result = await executeApprovedAction(approval);
    await safeRecordResponse(approval.decisionId, result.ok ? "approved" : "ignored");
    sendJson(response, result.ok
      ? { ok: true, executed: approval.action?.summary || "", ...(result.reason ? { reason: result.reason } : {}) }
      : { ok: false, reason: result.error?.message || result.reason || "The action could not be executed." });
  } catch (error) {
    console.error(`${action} handler failed: ${error.message}`);
    sendJson(response, { ok: false, reason: "Valey could not process that request." });
  }
}

// Same executors index.js dispatches to; its executeApprovedAction() is not exported.
async function executeApprovedAction(approval, executors = {}) {
  const action = approval.action;
  console.log(`Executing dashboard pending record: ${JSON.stringify(approval || null)}`);
  console.log(`Executing dashboard proposedAction: ${JSON.stringify(action || null)}`);

  const draft = executors.createDraft || createDraft;
  const calendar = executors.createEvent || createEvent;
  const telegram = executors.sendTelegramMessage || sendTelegramMessage;

  if (action?.type === "email_reply") {
    return draft(action.payload || {});
  }

  if (action?.type === "calendar_event") {
    return calendar(action.payload || {});
  }

  if (action?.type === "alarm") {
    const reminder = reminderEventPayload(action);
    const result = await calendar(reminder.payload);
    return { ...result, ...(reminder.reason ? { reason: reminder.reason } : {}) };
  }

  if (action?.type === "message_reply") {
    const payload = action.payload || {};
    return telegram(payload.text || payload.body || payload.message || "");
  }

  return { ok: false, reason: `No executor for action type ${action?.type || "unknown"}` };
}

function reminderEventPayload(action) {
  const payload = normalizeObjectPayload(action?.payload);
  const datetime = findAlarmDatetime(action);
  let startMs = datetime.value === undefined ? NaN : Date.parse(datetime.value);
  let reason = null;

  if (Number.isFinite(startMs)) {
    console.log(`Alarm datetime field found: ${datetime.field}`);
  } else {
    const fallback = fallbackAlarmDatetime(action);
    startMs = fallback.startMs;
    reason = fallback.reason;
    console.log(`Alarm datetime field found: ${fallback.field}`);
  }

  return {
    payload: {
      summary: payload.summary || action?.summary || "Valey reminder",
      start: new Date(startMs).toISOString(),
      end: payload.end || new Date(startMs + 15 * 60 * 1000).toISOString(),
      description: payload.description || "Reminder created by Valey after approval.",
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 0 }] }
    },
    reason
  };
}

function normalizeObjectPayload(payload) {
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
}

function findAlarmDatetime(action) {
  const payload = action?.payload;

  if (typeof payload === "string") {
    return { field: "payload", value: payload };
  }

  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    for (const field of ["datetime", "when", "time", "start"]) {
      if (payload[field]) {
        return { field: `payload.${field}`, value: payload[field] };
      }
    }
  }

  for (const field of ["datetime", "when", "time", "start"]) {
    if (action?.[field]) {
      return { field, value: action[field] };
    }
  }

  return { field: "missing", value: undefined };
}

function fallbackAlarmDatetime(action) {
  const payload = normalizeObjectPayload(action?.payload);

  for (const field of ["dueAt", "deadline", "dueDate", "statedDeadline"]) {
    const value = payload[field] || action?.[field];
    const dueMs = Date.parse(value);

    if (Number.isFinite(dueMs)) {
      const start = new Date(dueMs);
      start.setUTCDate(start.getUTCDate() - 1);
      start.setUTCHours(9, 0, 0, 0);
      return {
        field: payload[field] ? `payload.${field}` : field,
        startMs: start.getTime(),
        reason: `Reminder datetime was missing or invalid, so Valey defaulted to 09:00 the day before the stated deadline.`
      };
    }
  }

  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  tomorrow.setUTCHours(9, 0, 0, 0);
  return {
    field: "default",
    startMs: tomorrow.getTime(),
    reason: "Reminder datetime and deadline were missing or invalid, so Valey defaulted the reminder to tomorrow at 09:00."
  };
}

// JSON-only bodies: a cross-site HTML form cannot produce one, and a cross-origin fetch fails preflight.
async function readJsonBody(request) {
  if (!/^application\/json\b/i.test(request.headers["content-type"] || "")) {
    return null;
  }

  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;

    if (size > MAX_JSON_BODY_BYTES) {
      return null;
    }

    chunks.push(chunk);
  }

  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function sendJson(response, body) {
  response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

// Clearing archives first, then rewrites. Marker entries are the ledger and survive every clear.
async function handleClearLog(request, response) {
  try {
    const body = await readJsonBody(request);
    const scope = String(body?.scope || "");

    if (!body || !CLEAR_SCOPES.has(scope)) {
      sendJson(response, { ok: false, reason: "Send a JSON body with scope 'all' or 'low'." });
      return;
    }

    const log = await readStateJson("decisions.json", []);
    const archivedTo = await archiveDecisions();
    const { kept, removed } = partitionLog(log, scope);
    const marker = clearMarker(scope, removed, archivedTo);
    await writeDecisions([...kept, marker]);
    sendJson(response, { ok: true, removed, archivedTo });
  } catch (error) {
    console.error(`Clear log failed: ${error.message}`);
    sendJson(response, { ok: false, reason: "Valey could not clear the log. Nothing was changed." });
  }
}

// Moves the live file aside untouched, malformed or not; returns null when there is nothing to archive.
async function archiveDecisions() {
  const source = path.join(STATE_DIR, "decisions.json");
  const archiveDir = path.join(STATE_DIR, "archive");
  const target = path.join(archiveDir, `decisions-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

  try {
    await mkdir(archiveDir, { recursive: true });
    await rename(source, target);
    return path.relative(process.cwd(), target).split(path.sep).join("/");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function partitionLog(log, scope) {
  const entries = log.filter((entry) => entry && typeof entry === "object");
  const kept = entries.filter((entry) => isMarker(entry) || (scope === "low" && entry.tier !== "low"));
  return { kept, removed: entries.length - kept.length };
}

function clearMarker(scope, removed, archivedTo) {
  return {
    id: `clear-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    kind: "marker",
    source: "system",
    recordedAt: new Date().toISOString(),
    tier: null,
    channel: null,
    category: "log-cleared",
    reason: scope === "low" ? "Low priority entries cleared." : "Activity log cleared.",
    scope,
    removed,
    archivedTo,
    response: null,
    responseAt: null
  };
}

function isMarker(entry) {
  return entry?.kind === "marker";
}

async function writeDecisions(log) {
  await mkdir(STATE_DIR, { recursive: true });
  const tempFile = path.join(STATE_DIR, `decisions.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tempFile, `${JSON.stringify(log, null, 2)}\n`, "utf8");
  await rename(tempFile, path.join(STATE_DIR, "decisions.json"));
}

async function handleSummary(response) {
  try {
    sendJson(response, await buildSummary());
  } catch (error) {
    console.error(`Summary failed: ${error.message}`);
    sendJson(response, { ...buildSummaryFrom([], {}), degraded: true });
  }
}

async function handleSummarySpeak(response) {
  try {
    const summary = await buildSummary();
    const voice = await import("./adapters/out/voice.js");
    const result = await voice.sendVoiceNote(summary.text);
    sendJson(response, result.ok
      ? { ok: true, degraded: Boolean(result.degraded) }
      : { ok: false, degraded: false, reason: result.error || "The voice note could not be sent." });
  } catch (error) {
    console.error(`Summary speak failed: ${error.message}`);
    sendJson(response, { ok: false, degraded: false, reason: "Valey could not send the summary." });
  }
}

async function buildSummary() {
  const log = await readStateJson("decisions.json", []);
  const pending = await readStateJson("pending.json", {});
  return buildSummaryFrom(log, pending);
}

// Plain-language digest of the last 24 hours built from stored reason fields only.
// Withheld items are counted and never described.
function buildSummaryFrom(rawLog, pendingMap, now = Date.now()) {
  const since = now - DAY_MS;
  const recent = rawLog.filter((entry) => entry && typeof entry === "object" && !isMarker(entry) && Date.parse(entry.recordedAt) >= since);
  const spoken = recent.filter((entry) => entry.category !== "financial");
  const pending = Object.values(pendingMap).filter((item) => item && Date.parse(item.expiresAt) > now);
  const today = new Date(now).toDateString();
  const dueToday = spoken.filter((entry) => entry.source === "calendar" && new Date(Date.parse(entry.recordedAt)).toDateString() === today).reverse();
  const tally = (tier) => recent.filter((entry) => entry.tier === tier).length;
  const counts = {
    handled: recent.length,
    critical: tally("critical"),
    high: tally("high"),
    normal: tally("normal"),
    low: tally("low"),
    withheld: recent.length - spoken.length,
    awaitingApproval: pending.length,
    dueToday: dueToday.length
  };
  const attention = groupSummaryItems(spoken.filter((entry) => entry.tier === "critical" || entry.tier === "high"));
  const upcoming = groupSummaryItems(dueToday);
  const sentences = [];

  if (!recent.length) {
    sentences.push("Valey has not recorded anything in the last 24 hours.");
  } else if (attention.length) {
    sentences.push(actionBriefing(attention));
  } else {
    sentences.push("Nothing needs your attention right now.");
  }

  if (pending.length) {
    sentences.push(`${capitalize(numberWord(pending.length))} ${pending.length === 1 ? "action is" : "actions are"} awaiting your approval.`);
  } else if (recent.length) {
    sentences.push("Nothing is awaiting your approval.");
  }

  if (upcoming.length) {
    sentences.push(upcomingBriefing(upcoming));
  }

  if (counts.withheld) {
    sentences.push(`${capitalize(numberWord(counts.withheld))} ${counts.withheld === 1 ? "item was" : "items were"} withheld as financial or one-time-code material.`);
  }

  if (recent.length) {
    sentences.push(countsBriefing(counts));
  }

  return { text: enforceWordLimit(sentences, MAX_SUMMARY_WORDS), generatedAt: new Date(now).toISOString(), counts };
}

function groupSummaryItems(entries) {
  const groups = [];

  for (const entry of entries.slice().reverse()) {
    const phrase = briefReason(entry.reason);

    if (!phrase) {
      continue;
    }

    const key = summaryKey(phrase);
    const existing = groups.find((group) => similarSummaryKey(group.key, key));

    if (existing) {
      existing.count += 1;
      continue;
    }

    groups.push({ phrase, key, count: 1 });
  }

  return groups;
}

function briefReason(reason) {
  let text = String(reason || "").replace(/\s+/g, " ").trim();

  for (const pattern of INTERNAL_REASON_PATTERNS) {
    text = text.replace(pattern, "").trim();
  }

  text = firstClause(text).replace(/\bValey\b\s*/gi, "").replace(/[.,;:\s]+$/g, "").trim();

  if (!text) {
    return "";
  }

  return text
    .replace(/^electricity bill payment is due\b/i, "Your electricity bill is due")
    .replace(/^electricity bill is due\b/i, "Your electricity bill is due")
    .replace(/^final deadline\b/i, "The final deadline")
    .replace(/^investor call\b/i, "The investor call");
}

function firstClause(text) {
  const match = String(text || "").match(/^.*?(?:(?:\.\s)|(?:;\s)|(?::\s)|$)/);
  return (match?.[0] || text).replace(/[.;:]+$/g, "");
}

function summaryKey(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word && !SUMMARY_STOP_WORDS.has(word))
    .join(" ");
}

function similarSummaryKey(left, right) {
  if (!left || !right) {
    return false;
  }

  if (left === right || left.includes(right) || right.includes(left)) {
    return true;
  }

  const leftWords = new Set(left.split(" "));
  const rightWords = new Set(right.split(" "));
  const overlap = [...leftWords].filter((word) => rightWords.has(word)).length;
  const smaller = Math.min(leftWords.size, rightWords.size);
  return smaller > 0 && overlap / smaller >= 0.75;
}

function actionBriefing(groups) {
  const main = groups[0];
  const phrase = main.count > 1 ? `${main.phrase}, repeated ${numberWord(main.count)} times` : main.phrase;

  if (groups.length === 1) {
    return `${phrase} ${main.count > 1 ? "and is the main thing" : "and is the only thing"} that needs action.`;
  }

  return `${phrase} needs action first. ${groups.length === 2 ? groups[1].phrase : "There are other action items too."}`;
}

function upcomingBriefing(groups) {
  const main = groups[0];
  return `${main.phrase} is coming up.`;
}

function countsBriefing(counts) {
  const dominant = dominantTier(counts);
  const tail = dominant ? `, most of them ${dominant} priority` : "";
  return `Valey handled ${counts.handled} ${counts.handled === 1 ? "event" : "events"} in the last 24 hours${tail}.`;
}

function dominantTier(counts) {
  const tiers = [
    ["critical", counts.critical],
    ["high", counts.high],
    ["normal", counts.normal],
    ["low", counts.low]
  ];
  const [tier, count] = tiers.reduce((best, item) => (item[1] > best[1] ? item : best), ["", 0]);
  return count > counts.handled / 2 ? tier : "";
}

function enforceWordLimit(sentences, limit) {
  const kept = sentences.filter(Boolean);

  while (kept.length > 1 && wordCount(kept.join(" ")) > limit) {
    kept.splice(kept.length - 2, 1);
  }

  return kept.join(" ");
}

function wordCount(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

function numberWord(count) {
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  return words[count] || String(count);
}

function capitalize(text) {
  return `${String(text || "").slice(0, 1).toUpperCase()}${String(text || "").slice(1)}`;
}

async function buildDashboardState() {
  const log = await readStateJson("decisions.json", []);
  const pending = await readStateJson("pending.json", {});
  return summarize(log, pending);
}

function summarize(rawLog, pendingMap) {
  const now = Date.now();
  const entries = rawLog.filter((entry) => entry && typeof entry === "object");
  const log = entries.filter((entry) => !isMarker(entry));
  const markers = entries.filter(isMarker);
  const count = (predicate) => log.filter(predicate).length;
  const pending = Object.values(pendingMap)
    .filter((item) => item && Date.parse(item.expiresAt) > now)
    .map((item) => ({ ...item, action: { type: item.action?.type, summary: item.action?.summary } }));

  return {
    // Ledger markers always trail the events so they sit at the bottom of the feed.
    decisions: log.slice(-MAX_DASHBOARD_DECISIONS).reverse().map(publicDecision).concat(markers.slice().reverse()),
    timeline: log.slice(-TIMELINE_LENGTH).map((entry) => ({
      timestamp: entry.recordedAt,
      tier: entry.tier,
      source: entry.source,
      channel: entry.channel
    })),
    pending,
    stats: {
      total: log.length,
      last24h: count((entry) => Date.parse(entry.recordedAt) >= now - DAY_MS),
      avgResponseSeconds: averageResponseSeconds(log),
      critical: count((entry) => entry.tier === "critical"),
      high: count((entry) => entry.tier === "high"),
      normal: count((entry) => entry.tier === "normal"),
      low: count((entry) => entry.tier === "low"),
      withheld: count((entry) => entry.category === "financial"),
      callsPlaced: count((entry) => entry.channel === "call"),
      smsSent: count((entry) => entry.channel === "sms"),
      voiceNotes: count((entry) => entry.channel === "voice"),
      logged: count((entry) => entry.channel === "log"),
      approvalsPending: pending.length,
      approvalsExecuted: count((entry) => entry.response === "approved"),
      bySource: {
        gmail: count((entry) => entry.source === "gmail"),
        telegram: count((entry) => entry.source === "telegram"),
        discord: count((entry) => entry.source === "discord"),
        calendar: count((entry) => entry.source === "calendar")
      }
    },
    adapters: Object.entries(ADAPTER_ENV).map(([name, names]) => ({
      name,
      active: names.every((envName) => Boolean(process.env[envName]))
    }))
  };
}

// Mean seconds from a decision being recorded to the user answering it; null until someone has answered.
function averageResponseSeconds(log) {
  const durations = log
    .filter((entry) => entry.response && entry.responseAt)
    .map((entry) => (Date.parse(entry.responseAt) - Date.parse(entry.recordedAt)) / 1000)
    .filter((seconds) => Number.isFinite(seconds) && seconds >= 0);

  return durations.length ? Math.round(durations.reduce((sum, seconds) => sum + seconds, 0) / durations.length) : null;
}

// Withheld entries never leave the server with any text attached, redacted or not.
function publicDecision(entry) {
  return entry?.category === "financial" ? { ...entry, redactedText: undefined } : entry;
}

async function readStateJson(fileName, fallback) {
  try {
    const parsed = JSON.parse(await readFile(path.join(STATE_DIR, fileName), "utf8"));
    const shapeMatches = parsed && typeof parsed === "object" && Array.isArray(parsed) === Array.isArray(fallback);
    return shapeMatches ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function createServer() {
  return http.createServer(async (request, response) => {
    const query = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

    if (request.method === "GET" && STATIC_FILES[query.pathname]) {
      await handleStatic(response, STATIC_FILES[query.pathname]);
      return;
    }

    if (request.method === "GET" && query.pathname === "/api/state") {
      await handleState(response);
      return;
    }

    if (request.method === "POST" && (query.pathname === "/api/approve" || query.pathname === "/api/decline")) {
      await handleApproval(request, response, query.pathname.slice(5));
      return;
    }

    if (request.method === "POST" && query.pathname === "/api/clear-log") {
      await handleClearLog(request, response);
      return;
    }

    if (request.method === "GET" && query.pathname === "/api/summary") {
      await handleSummary(response);
      return;
    }

    if (request.method === "POST" && query.pathname === "/api/summary/speak") {
      await handleSummarySpeak(response);
      return;
    }

    if (request.method === "POST" && query.pathname === "/voice") {
      await handleVoice(request, response, query);
      return;
    }

    if (request.method === "POST" && query.pathname === "/voice/reply") {
      await handleVoiceReply(request, response);
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found.");
  });
}

async function runSelfTest() {
  const briefing = gatherTwiml("Urgent briefing & approval needed.");
  const reply = continueTwiml("I can help with that.");
  const passed = briefing.includes("<Gather input=\"speech\" action=\"/voice/reply\" method=\"POST\" speechTimeout=\"auto\" language=\"en-IN\">") &&
    briefing.includes("Urgent briefing &amp; approval needed.") &&
    reply.includes("What would you like me to do next?");

  console.log("Sample /voice TwiML:");
  console.log(briefing);
  console.log(`${passed ? "PASS" : "FAIL"} voice server twiml`);

  const endIntentPassed = [
    "bye",
    "Goodbye",
    "please end the call",
    "hang up now",
    "that's all",
    "thanks that's it",
    "cut the call",
    "stop",
    "done"
  ].every((text) => END_INTENT_PATTERN.test(text));
  console.log(`${endIntentPassed ? "PASS" : "FAIL"} voice end intent matching`);

  const capPassed = MAX_CALL_EXCHANGES === 5;
  console.log(`${capPassed ? "PASS" : "FAIL"} voice exchange cap`);

  const callApprovalPassed = [
    "yes",
    "yeah",
    "approve",
    "go ahead",
    "do it",
    "send it",
    "confirm",
    "okay do that"
  ].every((text) => APPROVAL_PATTERN.test(text));
  console.log(`${callApprovalPassed ? "PASS" : "FAIL"} voice approval matching`);

  const parsedAction = parseConversationResult("```json\n{\"speak\":\"I can draft that email for you.\",\"action\":{\"type\":\"draft_email\",\"payload\":{\"subject\":\"Hello\"}}}\n```");
  const actionParsePassed = parsedAction.speak === "I can draft that email for you." && parsedAction.action?.type === "draft_email";
  console.log(`${actionParsePassed ? "PASS" : "FAIL"} voice action json parsing`);

  const falseSuccess = parseConversationResult("{\"speak\":\"Okay, message sent.\",\"action\":null}");
  const falseSuccessPassed = falseSuccess.action === null && falseSuccess.speak === "I do not have anything queued to execute.";
  console.log(`${falseSuccessPassed ? "PASS" : "FAIL"} voice false success correction`);

  const spokenSafetyPassed = safeCallBriefing({ briefing: "Payment OTP 123456 for card" }).includes("withheld") &&
    safeSpokenText("Email person@example.test and read 1234567890 now").includes("an email address") &&
    !safeSpokenText("Email person@example.test and read 1234567890 now").includes("1234567890");
  console.log(`${spokenSafetyPassed ? "PASS" : "FAIL"} voice spoken safety`);

  const modelInputSafety = redactCallContext({
    body: "Wire payment OTP 123456",
    note: "Meet me at https://example.test and email person@example.test"
  });
  const modelInputSafetyPassed = modelInputSafety.body === "[WITHHELD]" &&
    safeSpokenText(modelInputSafety.note).includes("a link") &&
    !safeSpokenText(modelInputSafety.note).includes("person@example.test");
  console.log(`${modelInputSafetyPassed ? "PASS" : "FAIL"} voice model input safety`);

  const state = summarize(
    [{ tier: "critical", channel: "call", source: "gmail", category: "financial", redactedText: "secret", response: "approved" }, null],
    { A1: { code: "A1", action: { type: "email_reply", summary: "Reply", payload: { to: "x" } }, expiresAt: new Date(Date.now() + 60000).toISOString() }, A2: { code: "A2", expiresAt: "2000-01-01T00:00:00.000Z" } }
  );
  const statePassed = state.stats.total === 1 && state.stats.withheld === 1 && state.stats.approvalsExecuted === 1 &&
    state.pending.length === 1 && state.pending[0].action.payload === undefined &&
    state.decisions[0].redactedText === undefined && Array.isArray(summarize([], {}).decisions);
  console.log(`${statePassed ? "PASS" : "FAIL"} dashboard state`);

  const timed = summarize(
    [
      { tier: "high", channel: "sms", source: "gmail", recordedAt: "2026-09-12T10:00:00.000Z", response: "approved", responseAt: "2026-09-12T10:00:30.000Z" },
      { tier: "low", channel: "log", source: "discord", recordedAt: "2026-09-12T10:01:00.000Z", response: "rejected", responseAt: "2026-09-12T10:02:30.000Z" },
      { tier: "normal", channel: "voice", source: "telegram", recordedAt: "2026-09-12T10:03:00.000Z", response: null, responseAt: null }
    ],
    {}
  );
  const timelinePassed = timed.stats.avgResponseSeconds === 60 && summarize([], {}).stats.avgResponseSeconds === null &&
    timed.timeline.length === 3 && timed.timeline[0].timestamp === "2026-09-12T10:00:00.000Z" &&
    Object.keys(timed.timeline[2]).join() === "timestamp,tier,source,channel";
  console.log(`${timelinePassed ? "PASS" : "FAIL"} dashboard timeline`);

  const fakeRequest = (contentType, text) => Object.assign(Readable.from([Buffer.from(text)]), { headers: { "content-type": contentType } });
  const parsed = await readJsonBody(fakeRequest("application/json", '{"code":"a1"}'));
  const rejectedForm = await readJsonBody(fakeRequest("application/x-www-form-urlencoded", "code=A1"));
  const rejectedJunk = await readJsonBody(fakeRequest("application/json", "{nope"));
  const executed = [];
  const testExecutors = {
    createDraft: async (payload) => {
      executed.push(["email_reply", payload]);
      return { ok: true, draftId: "draft-test" };
    },
    createEvent: async (payload) => {
      executed.push([payload.reminders ? "alarm" : "calendar_event", payload]);
      return { ok: true, eventId: "event-test" };
    },
    sendTelegramMessage: async (text) => {
      executed.push(["message_reply", text]);
      return { ok: true };
    }
  };
  const emailApproval = await executeApprovedAction({ action: { type: "email_reply", payload: { subject: "Hello" } } }, testExecutors);
  const calendarApproval = await executeApprovedAction({
    action: { type: "calendar_event", payload: { summary: "Call", start: "2026-09-12T10:00:00.000Z", end: "2026-09-12T10:30:00.000Z" } }
  }, testExecutors);
  const alarmInputs = [
    { action: { type: "alarm", payload: { summary: "Pay bill", datetime: "2026-09-14T09:00:00.000Z" } } },
    { action: { type: "alarm", payload: { summary: "Pay bill", when: "2026-09-14T10:00:00.000Z" } } },
    { action: { type: "alarm", payload: { summary: "Pay bill", time: "2026-09-14T11:00:00.000Z" } } },
    { action: { type: "alarm", payload: "2026-09-14T12:00:00.000Z" } }
  ];
  const alarmApprovals = [];

  for (const approval of alarmInputs) {
    alarmApprovals.push(await executeApprovedAction(approval, testExecutors));
  }

  const alarmFallback = await executeApprovedAction({
    action: { type: "alarm", payload: { summary: "Pay bill", when: "later", dueAt: "2026-09-15T18:00:00.000Z" } }
  }, testExecutors);
  const messageApproval = await executeApprovedAction({ action: { type: "message_reply", payload: { text: "Approved." } } }, testExecutors);
  const unknown = await executeApprovedAction({ action: { type: "nope", payload: {} } }, testExecutors);
  const alarmEvents = executed.filter(([type]) => type === "alarm");
  const executorPassed = emailApproval.ok && calendarApproval.ok && alarmApprovals.every((result) => result.ok) &&
    alarmFallback.ok && alarmFallback.reason?.includes("day before the stated deadline") && messageApproval.ok &&
    executed.length === 8 &&
    executed.some(([type]) => type === "email_reply") &&
    executed.some(([type]) => type === "calendar_event") &&
    alarmEvents.length === 5 &&
    alarmEvents.every(([, payload]) => payload.reminders?.overrides?.[0]?.method === "popup") &&
    alarmEvents.some(([, payload]) => payload.start === "2026-09-14T09:00:00.000Z") &&
    alarmEvents.some(([, payload]) => payload.start === "2026-09-14T10:00:00.000Z") &&
    alarmEvents.some(([, payload]) => payload.start === "2026-09-14T11:00:00.000Z") &&
    alarmEvents.some(([, payload]) => payload.start === "2026-09-14T12:00:00.000Z") &&
    alarmEvents.some(([, payload]) => payload.start === "2026-09-14T09:00:00.000Z" && payload.summary === "Pay bill") &&
    executed.some(([type, text]) => type === "message_reply" && text === "Approved.") &&
    unknown.ok === false && unknown.reason === "No executor for action type nope";
  const approvalPassed = parsed?.code === "a1" && rejectedForm === null && rejectedJunk === null &&
    executorPassed && APPROVAL_CODE.test("A12") && !APPROVAL_CODE.test("A123") && !APPROVAL_CODE.test("");
  console.log(`${approvalPassed ? "PASS" : "FAIL"} approval endpoint guards`);
  console.log(`${executorPassed ? "PASS" : "FAIL"} approval action executors`);

  const sampleNow = Date.parse("2026-09-12T12:00:00.000Z");
  const sampleLog = [
    clearMarker("low", 4, "state/archive/old.json"),
    { id: "old", tier: "high", channel: "sms", source: "gmail", category: "general", reason: "Two days old.", recordedAt: "2026-09-10T12:00:00.000Z" },
    { id: "c1", tier: "critical", channel: "call", source: "gmail", category: "deadline", reason: "Electricity bill payment is due Tuesday.", recordedAt: "2026-09-12T09:00:00.000Z" },
    { id: "f1", tier: "low", channel: "log", source: "gmail", category: "financial", reason: "SECRET BANK SENDER", redactedText: "SECRET BODY", recordedAt: "2026-09-12T10:00:00.000Z" },
    { id: "k1", tier: "high", channel: "sms", source: "calendar", category: "schedule", reason: "Investor call moved to 2:30pm.", recordedAt: "2026-09-12T11:00:00.000Z" },
    { id: "l1", tier: "low", channel: "log", source: "discord", category: "general", reason: "Routine digest.", recordedAt: "2026-09-12T11:30:00.000Z" }
  ];
  const samplePending = { A1: { code: "A1", action: { type: "email_reply", summary: "Confirm the repo link" }, expiresAt: "2026-09-12T12:30:00.000Z" } };
  const digest = buildSummaryFrom(sampleLog, samplePending, sampleNow);
  const digestWords = wordCount(digest.text);
  const lowClear = partitionLog(sampleLog, "low");
  const allClear = partitionLog(sampleLog, "all");
  const duplicateLog = [
    { id: "d1", tier: "critical", channel: "call", source: "gmail", category: "deadline", reason: "Electricity bill payment is due soon.", recordedAt: "2026-09-12T08:00:00.000Z" },
    { id: "d2", tier: "critical", channel: "sms", source: "gmail", category: "deadline", reason: "Electricity bill payment is due soon. Call rate limit reached, so Valey downgraded this alert to SMS.", recordedAt: "2026-09-12T08:10:00.000Z" },
    { id: "d3", tier: "high", channel: "sms", source: "gmail", category: "deadline", reason: "Electricity bill is due soon.", recordedAt: "2026-09-12T08:20:00.000Z" },
    { id: "d4", tier: "critical", channel: "call", source: "gmail", category: "deadline", reason: "Electricity bill payment is due soon. Call rate limit reached, so Valey downgraded this alert to SMS.", recordedAt: "2026-09-12T08:30:00.000Z" },
    { id: "d5", tier: "critical", channel: "sms", source: "gmail", category: "deadline", reason: "Electricity bill payment is due soon. Call rate limit reached, so Valey downgraded this alert to SMS.", recordedAt: "2026-09-12T08:40:00.000Z" },
    { id: "d6", tier: "low", channel: "log", source: "gmail", category: "financial", reason: "SECRET BANK SENDER", redactedText: "SECRET BODY", recordedAt: "2026-09-12T08:50:00.000Z" }
  ];
  const duplicateDigest = buildSummaryFrom(duplicateLog, {}, sampleNow);
  const billMentions = duplicateDigest.text.match(/electricity bill/gi)?.length || 0;
  const summaryPassed = digest.counts.handled === 4 && digest.counts.withheld === 1 && digest.counts.awaitingApproval === 1 && digest.counts.dueToday === 1 &&
    digestWords <= MAX_SUMMARY_WORDS && !digest.text.includes("SECRET") && !digest.text.includes("Confirm the repo link") && digest.text.includes("Investor call") &&
    !digest.text.includes("Two days old") && !digest.text.includes("and 1 more") && !digest.text.includes("...") &&
    buildSummaryFrom([], {}, sampleNow).text.includes("not recorded anything") &&
    billMentions === 1 && !/rate limit|downgraded|fallback|classifier/i.test(duplicateDigest.text) && wordCount(duplicateDigest.text) <= MAX_SUMMARY_WORDS &&
    lowClear.removed === 2 && lowClear.kept.length === 4 && isMarker(lowClear.kept[0]) &&
    allClear.removed === 5 && allClear.kept.length === 1 && isMarker(allClear.kept[0]);
  console.log(`${summaryPassed ? "PASS" : "FAIL"} log clearing and daily summary`);
  if (!summaryPassed) {
    console.log(`Digest: ${digest.text}`);
    console.log(`Duplicate digest: ${duplicateDigest.text}`);
  }
  console.log(`${billMentions === 1 ? "PASS" : "FAIL"} summary deduplicates reminders`);

  if (!passed || !endIntentPassed || !capPassed || !callApprovalPassed || !actionParsePassed || !falseSuccessPassed || !spokenSafetyPassed || !modelInputSafetyPassed || !statePassed || !timelinePassed || !approvalPassed || !summaryPassed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.env.VALEY_SELF_TEST === "server") {
    await runSelfTest();
    process.exit(process.exitCode || 0);
  }

  createServer().listen(PORT, () => {
    console.log(`Valey voice server listening on port ${PORT}.`);
  });
}
