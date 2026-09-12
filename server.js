import "dotenv/config";
import http from "node:http";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { appendCallTurn, getActiveCall } from "./core/active-calls.js";

const PORT = Number(process.env.PORT || 3000);
const DEFAULT_BRIEFING = "Valey found an urgent item that needs your attention.";
const STOP_PATTERN = /\b(stop|goodbye)\b/i;

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

    if (!speech || STOP_PATTERN.test(speech)) {
      sendTwiML(response, sayTwiml("Okay, goodbye."));
      return;
    }

    const call = callSid ? await getActiveCall(callSid) : null;
    const reply = await getSpokenReply(speech, call);

    if (callSid) {
      await appendCallTurn(callSid, speech, reply);
    }

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

export function createServer() {
  return http.createServer(async (request, response) => {
    const query = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

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

  if (!passed) {
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
