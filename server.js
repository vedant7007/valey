import "dotenv/config";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { appendCallTurn, getActiveCall } from "./core/active-calls.js";

const PORT = Number(process.env.PORT || 3000);
const DEFAULT_BRIEFING = "Valey found an urgent item that needs your attention.";
const END_INTENT_PATTERN = /\b(?:bye|goodbye|end the call|hang up|that's all|thanks that's it|cut the call|stop|done)\b/i;
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
    sendTwiML(response, gatherTwiml(call?.briefing || DEFAULT_BRIEFING));
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

    const reply = await getSpokenReply(speech, call);

    await appendCallTurn(callSid, speech, reply);

    sendTwiML(response, continueTwiml(reply));
  } catch (error) {
    console.error(`Voice reply handler failed: ${error.message}`);
    sendTwiML(response, sayTwiml("Sorry, Valey had trouble understanding that. Goodbye."));
  }
}

async function getSpokenReply(userSpeech, call) {
  if (!process.env.OPENROUTER_API_KEY) {
    return "I heard you. Please reply in the original channel to approve any action.";
  }

  try {
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
          content: "You are Valey on a phone call. Reply in under 30 words. Be concise, spoken, and action-oriented. Do not execute actions without explicit approval."
        },
        {
          role: "user",
          content: JSON.stringify({
            originalContext: call ? { briefing: call.briefing, context: call.context, history: call.history || [] } : null,
            userSpeech
          })
        }
      ]
    });
    return limitWords(completion.choices?.[0]?.message?.content || "I heard you. What should I do next?", 30);
  } catch (error) {
    console.error(`Conversation model failed: ${error.message}`);
    return "I heard you, but I could not think clearly. Please reply in the original channel.";
  }
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
