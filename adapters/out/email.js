import { fileURLToPath } from "node:url";
import { google } from "googleapis";
import { getGoogleOAuthClient } from "../../core/google.js";

export async function createDraft({ to, subject, body, threadId }) {
  const auth = getGoogleOAuthClient();

  if (!auth.ok) {
    return auth;
  }

  try {
    const gmail = google.gmail({ version: "v1", auth: auth.client });
    const requestBody = {
      message: {
        raw: encodeMessage({ to, subject, body })
      }
    };

    if (threadId) {
      requestBody.message.threadId = threadId;
    }

    // The agent drafts, the human releases. This adapter deliberately never sends mail.
    const response = await gmail.users.drafts.create({
      userId: "me",
      requestBody
    });

    return { ok: true, draftId: response.data.id };
  } catch (error) {
    return { ok: false, error: { message: error.message, code: error.code || error.response?.status || null } };
  }
}

function encodeMessage({ to, subject, body }) {
  const message = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "MIME-Version: 1.0",
    "",
    body
  ].join("\r\n");

  return Buffer.from(message, "utf8").toString("base64url");
}

function runSelfTest() {
  const raw = encodeMessage({
    to: "person@example.test",
    subject: "Draft subject",
    body: "Draft body"
  });
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const passed = decoded.includes("To: person@example.test") && decoded.includes("Subject: Draft subject") && decoded.endsWith("Draft body");

  console.log(`${passed ? "PASS" : "FAIL"} email draft encoding`);

  if (!passed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runSelfTest();
  process.exit(process.exitCode || 0);
}
