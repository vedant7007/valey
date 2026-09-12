import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { getRecentDecisions } from "./memory.js";
import { isFinancial, redact } from "./redact.js";

const DEFAULT_MODEL = "openai/gpt-4o-mini";
const TIERS = new Set(["critical", "high", "normal", "low"]);
const ACTION_TYPES = new Set(["email_reply", "calendar_event", "message_reply", "alarm"]);

export async function classify(event) {
  const redacted = redact(event.text);

  if (isFinancial(event.text)) {
    return {
      tier: "low",
      reason: "Financial, OTP, or security-sensitive content was withheld and logged only.",
      category: "financial",
      suggestedAction: null,
      channelIntent: "log"
    };
  }

  if (!process.env.OPENROUTER_API_KEY) {
    return {
      tier: "normal",
      reason: "Classifier model was unavailable because OPENROUTER_API_KEY is not set.",
      category: "general",
      suggestedAction: null
    };
  }

  const recentDecisions = await getRecentDecisions(10);
  const client = new OpenAI({
    baseURL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY
  });

  try {
    const response = await client.chat.completions.create({
      model: process.env.CLASSIFIER_MODEL || DEFAULT_MODEL,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: [
            "You classify Valey events and return strict JSON only.",
            "No prose. No markdown fences.",
            "Tiers:",
            "critical = a hard deadline inside 24 hours, an emergency, a security or access problem, or something with real cost if missed.",
            "high = needs a reply today, a scheduling request, or a blocked person waiting.",
            "normal = useful to know, no time pressure.",
            "low = newsletters, automated notices, social chatter.",
            "Repeated dismissals of a category should lower that category's tier by one step, but never below normal.",
            "Never downgrade override categories: deadline, payment failure, security alert, interview, or a direct question addressed to the user.",
            "Suppression may downgrade, never silence.",
            "Return exactly: {\"tier\":\"critical|high|normal|low\",\"reason\":\"one short sentence\",\"category\":\"short lowercase label\",\"suggestedAction\":null|{\"type\":\"email_reply|calendar_event|message_reply|alarm\",\"summary\":\"plain-language summary\",\"payload\":{}}}"
          ].join("\n")
        },
        {
          role: "user",
          content: JSON.stringify({
            event: {
              id: event.id,
              source: event.source,
              threadId: event.threadId,
              author: event.author?.displayName || "unknown",
              text: redacted.clean,
              receivedAt: event.receivedAt,
              redactions: redacted.found
            },
            recentDecisions
          })
        }
      ]
    });

    return normalizeModelResult(response.choices?.[0]?.message?.content);
  } catch (error) {
    return {
      tier: "normal",
      reason: `Classifier failed, so Valey used the normal fallback: ${error.message}`,
      category: "general",
      suggestedAction: null
    };
  }
}

function normalizeModelResult(content) {
  try {
    const parsed = JSON.parse(stripFences(content || ""));
    const tier = TIERS.has(parsed.tier) ? parsed.tier : "normal";
    const category = typeof parsed.category === "string" && parsed.category.trim() ? parsed.category.trim().toLowerCase() : "general";
    const reason = typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "Valey classified this with a normal fallback.";
    const suggestedAction = normalizeSuggestedAction(parsed.suggestedAction);

    return { tier, reason, category, suggestedAction };
  } catch {
    return {
      tier: "normal",
      reason: "Classifier returned invalid JSON, so Valey used the normal fallback.",
      category: "general",
      suggestedAction: null
    };
  }
}

function normalizeSuggestedAction(action) {
  if (action === null || action === undefined) {
    return null;
  }

  if (!action || typeof action !== "object" || Array.isArray(action)) {
    return null;
  }

  if (!ACTION_TYPES.has(action.type)) {
    return null;
  }

  return {
    type: action.type,
    summary: typeof action.summary === "string" && action.summary.trim() ? action.summary.trim() : "Review and approve the drafted action.",
    payload: action.payload && typeof action.payload === "object" && !Array.isArray(action.payload) ? action.payload : {}
  };
}

function stripFences(content) {
  return content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

async function runSelfTest() {
  const financial = await classify({
    id: "gmail:msg-1",
    source: "gmail",
    threadId: null,
    author: { displayName: "Sender" },
    text: "Security alert: payment OTP 123456",
    receivedAt: "2026-09-12T08:42:00.000Z"
  });
  const noKey = await classify({
    id: "gmail:msg-2",
    source: "gmail",
    threadId: null,
    author: { displayName: "Sender" },
    text: "Can you review this when free?",
    receivedAt: "2026-09-12T08:42:00.000Z"
  });
  const passed = financial.tier === "low" && financial.channelIntent === "log" && noKey.tier === "normal";

  console.log(`${passed ? "PASS" : "FAIL"} classifier safeguards`);

  if (!passed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runSelfTest().catch((error) => {
    console.error(`FAIL classifier safeguards: ${error.message}`);
    process.exitCode = 1;
  });
}
