import { fileURLToPath } from "node:url";
import twilio from "twilio";
import { recordActiveCall } from "../../core/active-calls.js";

const MAX_SPOKEN_CHARS = 300;
const DEFAULT_SPOKEN_TEXT = "Valey found an urgent item that needs your attention.";

export async function placeCall(spokenText) {
  const config = getTwilioConfig();

  if (!config.ok) {
    return config;
  }

  const briefing = normalizeSpokenText(spokenText);
  const voiceUrl = new URL("/voice", config.publicUrl).toString();
  console.log(`Twilio call webhook: ${voiceUrl}`);

  try {
    const client = twilio(config.accountSid, config.authToken);
    const call = await client.calls.create({
      to: config.userPhoneNumber,
      from: config.twilioPhoneNumber,
      url: voiceUrl
    });

    await recordActiveCall(call.sid, briefing, { channel: "call" });
    console.log(`Twilio call created: sid=${call.sid} status=${call.status}`);
    return { ok: true };
  } catch (error) {
    if (error.code) {
      console.error(`Twilio call failed with code ${error.code}`);
    }

    return { ok: false, error: { message: error.message, code: error.code || null } };
  }
}

function getTwilioConfig() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
  const userPhoneNumber = process.env.USER_PHONE_NUMBER;
  const publicUrl = process.env.PUBLIC_URL;

  if (!accountSid || !authToken || !twilioPhoneNumber || !userPhoneNumber || !publicUrl) {
    return {
      ok: false,
      error: {
        message: "Missing Twilio call environment variables.",
        missing: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "USER_PHONE_NUMBER", "PUBLIC_URL"].filter((name) => !process.env[name])
      }
    };
  }

  try {
    const parsed = new URL(publicUrl);

    if (parsed.protocol !== "https:") {
      return { ok: false, error: { message: "PUBLIC_URL must be an https URL reachable by Twilio." } };
    }
  } catch {
    return { ok: false, error: { message: "PUBLIC_URL must be a valid https URL reachable by Twilio." } };
  }

  return { ok: true, accountSid, authToken, twilioPhoneNumber, userPhoneNumber, publicUrl };
}

export function buildTwiML(spokenText) {
  const escaped = escapeXml(normalizeSpokenText(spokenText));
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="1"/><Say voice="alice">${escaped}</Say></Response>`;
}

function normalizeSpokenText(text) {
  return capText(text, MAX_SPOKEN_CHARS) || DEFAULT_SPOKEN_TEXT;
}

function capText(text, maxLength) {
  const value = String(text ?? "").trim();
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function escapeXml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function runSelfTest() {
  const sample = "Urgent: R&D's launch review is blocked & needs approval.";
  const twiml = buildTwiML(sample);
  const emptyTwiml = buildTwiML("   ");
  console.log("Sample TwiML:");
  console.log(twiml);
  const passed = [
    twiml.startsWith("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Pause length=\"1\"/><Say voice=\"alice\">"),
    twiml.endsWith("</Say></Response>"),
    twiml.includes("R&amp;D&apos;s launch review"),
    twiml.includes("blocked &amp; needs approval."),
    !twiml.includes("Urgent: R&D's"),
    twiml.includes("Urgent: "),
    emptyTwiml.includes(DEFAULT_SPOKEN_TEXT)
  ].every(Boolean);

  console.log(`${passed ? "PASS" : "FAIL"} call twiml generation`);

  if (!passed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runSelfTest().catch((error) => {
    console.error(`FAIL call missing-env guard: ${error.message}`);
    process.exitCode = 1;
  });
}
