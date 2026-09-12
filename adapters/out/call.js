import { fileURLToPath } from "node:url";
import twilio from "twilio";

const MAX_SPOKEN_CHARS = 300;
const DEFAULT_SPOKEN_TEXT = "Valey found an urgent item that needs your attention.";

export async function placeCall(spokenText) {
  const config = getTwilioConfig();

  if (!config.ok) {
    return config;
  }

  const twiml = buildTwiML(spokenText);
  console.log("Twilio call TwiML:");
  console.log(twiml);

  try {
    const client = twilio(config.accountSid, config.authToken);
    const call = await client.calls.create({
      to: config.userPhoneNumber,
      from: config.twilioPhoneNumber,
      twiml
    });

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

  if (!accountSid || !authToken || !twilioPhoneNumber || !userPhoneNumber) {
    return {
      ok: false,
      error: {
        message: "Missing Twilio call environment variables.",
        missing: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "USER_PHONE_NUMBER"].filter((name) => !process.env[name])
      }
    };
  }

  return { ok: true, accountSid, authToken, twilioPhoneNumber, userPhoneNumber };
}

export function buildTwiML(spokenText) {
  const script = capText(spokenText, MAX_SPOKEN_CHARS);
  const escaped = escapeXml(script).trim() || DEFAULT_SPOKEN_TEXT;
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="1"/><Say voice="alice">${escaped}</Say></Response>`;
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
