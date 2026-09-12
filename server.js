import "dotenv/config";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
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
const STATIC_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"]
};
const ADAPTER_ENV = {
  gmail: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"],
  calendar: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"],
  telegram: ["TELEGRAM_BOT_TOKEN"],
  discord: ["DISCORD_BOT_TOKEN"],
  twilio: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"]
};

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
      speak: result.ok ? callActionSuccessSpeech(mapPendingApprovalAction(existingApproval.action), result) : "I tried, but that action failed."
    };
  }

  if (!call?.pendingAction?.action) {
    return null;
  }

  const result = await executeCallAction(call.pendingAction.action);
  await setCallPendingAction(callSid, null);
  return {
    ok: result.ok,
    speak: result.ok ? callActionSuccessSpeech(call.pendingAction.action, result) : "I tried, but that action failed."
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
    return {
      speak: safeSpokenText(parsed.speak || "I can help with that. What would you like me to do?"),
      action: normalizeCallAction(parsed.action)
    };
  } catch {
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

async function buildDashboardState() {
  const log = await readStateJson("decisions.json", []);
  const pending = await readStateJson("pending.json", {});
  return summarize(log, pending);
}

function summarize(rawLog, pendingMap) {
  const now = Date.now();
  const log = rawLog.filter((entry) => entry && typeof entry === "object");
  const count = (predicate) => log.filter(predicate).length;
  const pending = Object.values(pendingMap)
    .filter((item) => item && Date.parse(item.expiresAt) > now)
    .map((item) => ({ ...item, action: { type: item.action?.type, summary: item.action?.summary } }));

  return {
    decisions: log.slice(-MAX_DASHBOARD_DECISIONS).reverse().map(publicDecision),
    pending,
    stats: {
      total: log.length,
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

  if (!passed || !endIntentPassed || !capPassed || !statePassed) {
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
