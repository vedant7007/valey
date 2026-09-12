import { fileURLToPath } from "node:url";
import twilio from "twilio";

const MAX_SPOKEN_CHARS = 300;

export async function placeCall(spokenText) {
  const config = getTwilioConfig();

  if (!config.ok) {
    return config;
  }

  const script = capText(spokenText, MAX_SPOKEN_CHARS);
  const twiml = `<Response><Say>${escapeXml(script)}</Say></Response>`;

  try {
    const client = twilio(config.accountSid, config.authToken);
    await client.calls.create({
      to: config.userPhoneNumber,
      from: config.twilioPhoneNumber,
      twiml
    });

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
  const result = await placeCall("A critical item needs approval. Reply approve to continue.");
  const passed = result.ok === false && result.error?.missing?.length > 0;

  console.log(`${passed ? "PASS" : "FAIL"} call missing-env guard`);

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
