import { fileURLToPath } from "node:url";

const SOURCES = new Set(["telegram", "discord", "gmail", "calendar"]);
const TIERS = new Set(["critical", "high", "normal", "low"]);
const CHANNELS = new Set(["call", "sms", "voice", "log"]);
const ACTION_TYPES = new Set(["email_reply", "calendar_event", "message_reply", "alarm"]);
const ISO_8601_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Canonical Event shape emitted by every inbound adapter:
 *
 * {
 *   id: string,              // "<source>:<sourceMessageId>"
 *   source: string,          // 'telegram' | 'discord' | 'gmail' | 'calendar'
 *   sourceMessageId: string,
 *   threadId: string | null,
 *   author: { id: string, displayName: string },
 *   text: string,            // plain text, markup stripped
 *   receivedAt: string,      // ISO 8601
 *   meta: object             // source-specific extras, never required by core
 * }
 */

/**
 * Decision shape returned by core/decide.js:
 *
 * {
 *   eventId: string,
 *   tier: 'critical' | 'high' | 'normal' | 'low',
 *   reason: string,          // one short human-readable sentence
 *   channel: 'call' | 'sms' | 'voice' | 'log',
 *   proposedAction: null | {
 *     type: 'email_reply' | 'calendar_event' | 'message_reply' | 'alarm',
 *     summary: string,       // plain-language description shown to the user
 *     payload: object
 *   },
 *   requiresApproval: boolean   // ALWAYS true whenever proposedAction is not null
 * }
 */

/**
 * Build and validate a canonical Valey event.
 *
 * The function accepts a partial event, fills optional defaults, derives `id`
 * as `<source>:<sourceMessageId>` when omitted, validates every required field,
 * and returns a normalized object suitable for the event bus.
 *
 * @param {object} partial Partial event emitted by an inbound adapter.
 * @returns {object} Canonical normalized event.
 * @throws {TypeError} When a required field is missing or has the wrong shape.
 */
export function normalizeEvent(partial) {
  if (!partial || typeof partial !== "object" || Array.isArray(partial)) {
    throw new TypeError("Event must be an object.");
  }

  const event = {
    threadId: null,
    receivedAt: new Date().toISOString(),
    meta: {},
    ...partial
  };

  const errors = [];

  if (!SOURCES.has(event.source)) {
    errors.push("source must be one of: telegram, discord, gmail, calendar.");
  }

  if (!isNonEmptyString(event.sourceMessageId)) {
    errors.push("sourceMessageId must be a non-empty string.");
  }

  if (!event.id && isNonEmptyString(event.source) && isNonEmptyString(event.sourceMessageId)) {
    event.id = `${event.source}:${event.sourceMessageId}`;
  }

  if (!isNonEmptyString(event.id)) {
    errors.push("id must be a non-empty string or derivable from source and sourceMessageId.");
  }

  if (event.threadId !== null && typeof event.threadId !== "string") {
    errors.push("threadId must be a string or null.");
  }

  if (!event.author || typeof event.author !== "object" || Array.isArray(event.author)) {
    errors.push("author must be an object.");
  } else {
    if (!isNonEmptyString(event.author.id)) {
      errors.push("author.id must be a non-empty string.");
    }
    if (!isNonEmptyString(event.author.displayName)) {
      errors.push("author.displayName must be a non-empty string.");
    }
  }

  if (typeof event.text !== "string") {
    errors.push("text must be a string.");
  }

  if (!isIsoDate(event.receivedAt)) {
    errors.push("receivedAt must be a valid ISO 8601 string.");
  } else {
    event.receivedAt = new Date(event.receivedAt).toISOString();
  }

  if (!event.meta || typeof event.meta !== "object" || Array.isArray(event.meta)) {
    errors.push("meta must be an object.");
  }

  if (errors.length > 0) {
    throw new TypeError(`Invalid event: ${errors.join(" ")}`);
  }

  return event;
}

/**
 * Validate a Valey decision object.
 *
 * This verifies the canonical Decision shape, accepted enum values, proposed
 * action fields, and the approval rule: `requiresApproval` must be true
 * whenever `proposedAction` is not null.
 *
 * @param {object} decision Decision candidate returned by core/decide.js.
 * @returns {{ valid: boolean, errors: string[] }} Validation result.
 */
export function validateDecision(decision) {
  const errors = [];

  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    return { valid: false, errors: ["decision must be an object."] };
  }

  if (!isNonEmptyString(decision.eventId)) {
    errors.push("eventId must be a non-empty string.");
  }

  if (!TIERS.has(decision.tier)) {
    errors.push("tier must be one of: critical, high, normal, low.");
  }

  if (!isNonEmptyString(decision.reason)) {
    errors.push("reason must be a non-empty string.");
  }

  if (!CHANNELS.has(decision.channel)) {
    errors.push("channel must be one of: call, sms, voice, log.");
  }

  if (typeof decision.requiresApproval !== "boolean") {
    errors.push("requiresApproval must be a boolean.");
  }

  if (decision.proposedAction !== null) {
    if (!decision.proposedAction || typeof decision.proposedAction !== "object" || Array.isArray(decision.proposedAction)) {
      errors.push("proposedAction must be null or an object.");
    } else {
      if (!ACTION_TYPES.has(decision.proposedAction.type)) {
        errors.push("proposedAction.type must be one of: email_reply, calendar_event, message_reply, alarm.");
      }
      if (!isNonEmptyString(decision.proposedAction.summary)) {
        errors.push("proposedAction.summary must be a non-empty string.");
      }
      if (!decision.proposedAction.payload || typeof decision.proposedAction.payload !== "object" || Array.isArray(decision.proposedAction.payload)) {
        errors.push("proposedAction.payload must be an object.");
      }
    }

    if (decision.requiresApproval !== true) {
      errors.push("requiresApproval must be true whenever proposedAction is not null.");
    }
  }

  return { valid: errors.length === 0, errors };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoDate(value) {
  if (!isNonEmptyString(value)) {
    return false;
  }

  const time = Date.parse(value);
  return Number.isFinite(time) && ISO_8601_DATE_TIME.test(value);
}

function runSelfTest() {
  const base = {
    source: "gmail",
    sourceMessageId: "msg-1",
    author: { id: "sender", displayName: "Sender" },
    text: "Hello",
    meta: {}
  };

  const cases = [
    {
      name: "accepts zulu timestamp without milliseconds",
      event: { ...base, receivedAt: "2026-09-12T08:42:00Z" },
      expected: "2026-09-12T08:42:00.000Z"
    },
    {
      name: "accepts offset timestamp",
      event: { ...base, receivedAt: "2026-09-12T14:12:00+05:30" },
      expected: "2026-09-12T08:42:00.000Z"
    }
  ];

  let failures = 0;

  for (const testCase of cases) {
    try {
      const normalized = normalizeEvent(testCase.event);
      const passed = normalized.receivedAt === testCase.expected;
      console.log(`${passed ? "PASS" : "FAIL"} ${testCase.name}`);

      if (!passed) {
        failures += 1;
        console.log(`  receivedAt: ${normalized.receivedAt}`);
      }
    } catch (error) {
      failures += 1;
      console.log(`FAIL ${testCase.name}`);
      console.log(`  ${error.message}`);
    }
  }

  if (failures > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runSelfTest();
}
