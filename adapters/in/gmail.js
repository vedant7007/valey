import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { google } from "googleapis";
import { publish } from "../../core/bus.js";
import { normalizeEvent } from "../../core/events.js";
import { getGoogleOAuthClient } from "../../core/google.js";

const POLL_MS = 30_000;
const MAX_SEEN = 200;
const STATE_DIR = path.resolve(process.env.VALEY_STATE_DIR || "state");
const SEEN_FILE = path.join(STATE_DIR, "gmail-seen.json");
const SKIPPED_LABELS = new Set(["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL"]);

let timer = null;
let running = false;

export async function start() {
  if (running) {
    return;
  }

  const auth = getGoogleOAuthClient();

  if (!auth.ok) {
    console.log(`Skipping gmail: ${auth.error.message}`);
    return;
  }

  running = true;
  await poll(auth.client);
  timer = setInterval(() => {
    poll(auth.client).catch((error) => console.error(`Gmail poll failed: ${error.message}`));
  }, POLL_MS);
}

export async function stop() {
  running = false;

  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function poll(auth) {
  const gmail = google.gmail({ version: "v1", auth });
  const seen = await readSeen();

  try {
    const listed = await gmail.users.messages.list({
      userId: "me",
      q: "is:unread newer_than:1d",
      maxResults: 20
    });

    for (const item of listed.data.messages || []) {
      if (!item.id || seen.includes(item.id)) {
        continue;
      }

      try {
        const message = await gmail.users.messages.get({
          userId: "me",
          id: item.id,
          format: "full"
        });

        if (shouldSkip(message.data.labelIds || [])) {
          seen.push(item.id);
          continue;
        }

        const event = normalizeEvent(toEvent(message.data));
        publish(event);
        seen.push(item.id);
      } catch (error) {
        if (error.code === 401 || error.response?.status === 401) {
          console.error("Gmail authorization failed with 401. The Google refresh token may be revoked.");
          continue;
        }

        console.error(`Skipping malformed Gmail message ${item.id}: ${error.message}`);
      }
    }

    await writeSeen(seen.slice(-MAX_SEEN));
  } catch (error) {
    if (error.code === 401 || error.response?.status === 401) {
      console.error("Gmail authorization failed with 401. The Google refresh token may be revoked.");
      return;
    }

    throw error;
  }
}

function toEvent(message) {
  const headers = headersToMap(message.payload?.headers || []);
  const from = headers.get("from") || "";
  const subject = headers.get("subject") || "";
  const author = parseFrom(from);
  const body = extractPlainText(message.payload);

  return {
    source: "gmail",
    sourceMessageId: String(message.id),
    threadId: String(message.threadId),
    author: {
      id: author.address,
      displayName: author.displayName || author.address
    },
    text: `${subject}\n\n${body}`.slice(0, 2000),
    receivedAt: new Date(Number(message.internalDate)).toISOString(),
    meta: {
      subject,
      from,
      labelIds: message.labelIds || []
    }
  };
}

function extractPlainText(payload) {
  const plain = findPart(payload, "text/plain");

  if (plain) {
    return decodeBase64Url(plain.body?.data || "").trim();
  }

  const html = findPart(payload, "text/html");
  return html ? stripHtml(decodeBase64Url(html.body?.data || "")).trim() : "";
}

function findPart(part, mimeType) {
  if (!part) {
    return null;
  }

  if (part.mimeType === mimeType && part.body?.data) {
    return part;
  }

  for (const child of part.parts || []) {
    const found = findPart(child, mimeType);

    if (found) {
      return found;
    }
  }

  return null;
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ");
}

function headersToMap(headers) {
  return new Map(headers.map((header) => [String(header.name || "").toLowerCase(), String(header.value || "")]));
}

function parseFrom(from) {
  const match = from.match(/^\s*(?:"?([^"<]*)"?\s*)?<([^>]+)>\s*$/);

  if (!match) {
    return { displayName: "", address: from.trim() };
  }

  return {
    displayName: match[1]?.trim() || "",
    address: match[2].trim()
  };
}

function shouldSkip(labelIds) {
  return labelIds.some((label) => SKIPPED_LABELS.has(label));
}

async function readSeen() {
  try {
    const content = await readFile(SEEN_FILE, "utf8");
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function writeSeen(ids) {
  await mkdir(STATE_DIR, { recursive: true });
  const tempFile = path.join(STATE_DIR, `gmail-seen.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tempFile, `${JSON.stringify(ids, null, 2)}\n`, "utf8");
  await rename(tempFile, SEEN_FILE);
}

function runSelfTest() {
  const body = Buffer.from("Hello from Gmail").toString("base64url");
  const message = {
    id: "abc",
    threadId: "thread",
    internalDate: String(Date.parse("2026-09-12T08:42:00.000Z")),
    labelIds: ["INBOX"],
    payload: {
      headers: [
        { name: "From", value: "Example Sender <sender@example.test>" },
        { name: "Subject", value: "Subject line" }
      ],
      parts: [{ mimeType: "text/plain", body: { data: body } }]
    }
  };
  const event = toEvent(message);
  const passed = event.source === "gmail" && event.author.id === "sender@example.test" && event.text.includes("Hello from Gmail") && shouldSkip(["CATEGORY_SOCIAL"]);

  console.log(`${passed ? "PASS" : "FAIL"} gmail message mapping`);

  if (!passed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runSelfTest();
  process.exit(process.exitCode || 0);
}
