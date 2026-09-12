import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { getRecentDecisions } from "./memory.js";
import { isFinancial, redact } from "./redact.js";

const DEFAULT_MODEL = "openai/gpt-4o-mini";
const TIERS = new Set(["critical", "high", "normal", "low"]);
const ACTION_TYPES = new Set(["email_reply", "calendar_event", "message_reply", "alarm"]);
const MARKETING_PATTERN = /\b(newsletter|digest|unsubscribe|promotion|promotional|product announcement|new feature|limited offer|sale|deal|webinar|launch event|marketing)\b/i;
const DUE_DATE_PATTERN = /\b(?:due|deadline|by|before|no later than|complete it before|time-bound|time bound)\b/i;
const WEEKDAYS = new Map([
  ["sunday", 0],
  ["monday", 1],
  ["tuesday", 2],
  ["wednesday", 3],
  ["thursday", 4],
  ["friday", 5],
  ["saturday", 6]
]);

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

  if (isMarketing(event.text, event.meta)) {
    return {
      tier: "low",
      reason: "Marketing, newsletter, announcement, or digest content is low priority even when it uses urgency words.",
      category: "marketing",
      suggestedAction: null
    };
  }

  if (!process.env.OPENROUTER_API_KEY) {
    const suggestedAction = inferTimeBoundAction(event);

    return {
      tier: suggestedAction ? "high" : "normal",
      reason: suggestedAction
        ? "This has a due date, so Valey can propose a reminder."
        : "Classifier model was unavailable because OPENROUTER_API_KEY is not set.",
      category: suggestedAction ? "deadline" : "general",
      suggestedAction
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
            "critical = a hard deadline inside 24 hours that the user personally must act on, an emergency, or a security or access problem.",
            "Marketing language, product announcements, newsletters, and automated digests are never critical regardless of urgent-sounding wording.",
            "Urgency words in marketing copy are not urgency.",
            "high = needs a reply today, a scheduling request, or a blocked person waiting.",
            "normal = useful to know, no time pressure.",
            "low = newsletters, automated notices, social chatter.",
            "Repeated dismissals of a category should lower that category's tier by one step, but never below normal.",
            "Never downgrade override categories: deadline, payment failure, security alert, interview, or a direct question addressed to the user.",
            "Suppression may downgrade, never silence.",
            "When an event contains a due date, deadline, or time-bound obligation, suggestedAction must not be null.",
            "For a due date, deadline, or time-bound obligation, return suggestedAction type alarm or calendar_event with an inferred datetime in payload.datetime.",
            "Parse relative dates such as this Tuesday and tomorrow against the current date from event.receivedAt.",
            "When no time is given, default payload.datetime to 09:00 on the morning of the day before the deadline.",
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

    return withInferredTimeBoundAction(normalizeModelResult(response.choices?.[0]?.message?.content), event);
  } catch (error) {
    const suggestedAction = inferTimeBoundAction(event);

    return {
      tier: suggestedAction ? "high" : "normal",
      reason: suggestedAction
        ? "This has a due date, so Valey can propose a reminder."
        : `Classifier failed, so Valey used the normal fallback: ${error.message}`,
      category: suggestedAction ? "deadline" : "general",
      suggestedAction
    };
  }
}

function isMarketing(text, meta = {}) {
  const value = `${text || ""}\n${meta?.subject || ""}\n${(meta?.labelIds || []).join(" ")}`;
  return MARKETING_PATTERN.test(value) || /\bCATEGORY_PROMOTIONS\b/i.test(value);
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

function withInferredTimeBoundAction(classification, event) {
  if (classification.suggestedAction) {
    return classification;
  }

  const suggestedAction = inferTimeBoundAction(event);

  if (!suggestedAction) {
    return classification;
  }

  return {
    ...classification,
    tier: classification.tier === "low" ? "normal" : classification.tier,
    category: classification.category === "general" ? "deadline" : classification.category,
    suggestedAction
  };
}

function inferTimeBoundAction(event) {
  const text = String(event?.text || "");

  if (!DUE_DATE_PATTERN.test(text)) {
    return null;
  }

  const dueAt = inferDueDate(text, event?.receivedAt);

  if (!dueAt) {
    return null;
  }

  const reminderAt = new Date(dueAt);
  reminderAt.setUTCDate(reminderAt.getUTCDate() - 1);
  reminderAt.setUTCHours(9, 0, 0, 0);

  return {
    type: "alarm",
    summary: "Set a reminder before the due date.",
    payload: {
      datetime: reminderAt.toISOString(),
      dueAt: dueAt.toISOString()
    }
  };
}

function inferDueDate(text, receivedAt) {
  const base = parseReferenceDate(receivedAt);
  const value = String(text || "").toLowerCase();

  if (/\btomorrow\b/i.test(value)) {
    return dateAtMorning(addDays(base, 1));
  }

  const weekdayMatch = value.match(/\b(?:this\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);

  if (weekdayMatch) {
    const targetDay = WEEKDAYS.get(weekdayMatch[1].toLowerCase());
    let daysAhead = targetDay - base.getUTCDay();

    if (daysAhead < 0 || (daysAhead === 0 && /\bthis\s+/i.test(weekdayMatch[0]) === false)) {
      daysAhead += 7;
    }

    return dateAtMorning(addDays(base, daysAhead));
  }

  const ordinalMatch = value.match(/\b(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/i);

  if (ordinalMatch) {
    const day = Number(ordinalMatch[1]);

    if (day >= 1 && day <= 31) {
      const candidate = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), day, 9, 0, 0, 0));

      if (candidate < startOfUtcDay(base)) {
        candidate.setUTCMonth(candidate.getUTCMonth() + 1);
      }

      return candidate;
    }
  }

  return null;
}

function parseReferenceDate(receivedAt) {
  const parsed = new Date(receivedAt || Date.now());
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function dateAtMorning(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 9, 0, 0, 0));
}

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
}

function stripFences(content) {
  return content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

async function runSelfTest() {
  const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const financial = await classify({
    id: "gmail:msg-1",
    source: "gmail",
    threadId: null,
    author: { displayName: "Sender" },
    text: "Security alert: payment OTP 123456",
    receivedAt: "2026-09-12T08:42:00.000Z"
  });
  delete process.env.OPENROUTER_API_KEY;
  const noKey = await classify({
    id: "gmail:msg-2",
    source: "gmail",
    threadId: null,
    author: { displayName: "Sender" },
    text: "Can you review this when free?",
    receivedAt: "2026-09-12T08:42:00.000Z"
  });
  if (originalOpenRouterKey === undefined) {
    delete process.env.OPENROUTER_API_KEY;
  } else {
    process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
  }
  const newsletterLiveToday = await classify({
    id: "gmail:msg-3",
    source: "gmail",
    threadId: null,
    author: { displayName: "Newsletter" },
    text: "Weekly newsletter: our demo is live today with a product announcement.",
    receivedAt: "2026-09-12T08:42:00.000Z",
    meta: { subject: "Weekly newsletter" }
  });
  const newsletterNeverRunOut = await classify({
    id: "gmail:msg-4",
    source: "gmail",
    threadId: null,
    author: { displayName: "Promo Team" },
    text: "Promotional digest: never run out of credits with our new feature.",
    receivedAt: "2026-09-12T08:42:00.000Z",
    meta: { labelIds: ["CATEGORY_PROMOTIONS"] }
  });
  delete process.env.OPENROUTER_API_KEY;
  const dueDateReminder = await classify({
    id: "gmail:msg-5",
    source: "gmail",
    threadId: null,
    author: { displayName: "Utility" },
    text: "Your electricity bill payment is due this Tuesday",
    receivedAt: "2026-09-12T08:42:00.000Z",
    meta: { subject: "Payment due" }
  });
  const cases = [
    ["financial content withheld", financial.tier === "low" && financial.channelIntent === "log"],
    ["missing key fallback", noKey.tier === "normal"],
    ["newsletter live today is low", newsletterLiveToday.tier === "low"],
    ["newsletter never run out is low", newsletterNeverRunOut.tier === "low"],
    ["due date gets reminder action", dueDateReminder.suggestedAction?.type === "alarm" &&
      Date.parse(dueDateReminder.suggestedAction.payload?.datetime) === Date.parse("2026-09-14T09:00:00.000Z")]
  ];
  const passed = cases.every(([, ok]) => ok);

  for (const [name, ok] of cases) {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  }

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
