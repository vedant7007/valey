import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { google } from "googleapis";
import { publish } from "../../core/bus.js";
import { normalizeEvent } from "../../core/events.js";
import { getGoogleOAuthClient } from "../../core/google.js";

const POLL_MS = 60_000;
const MAX_SEEN = 200;
const STATE_DIR = path.resolve(process.env.VALEY_STATE_DIR || "state");
const SEEN_FILE = path.join(STATE_DIR, "calendar-seen.json");

let timer = null;
let running = false;

export async function start() {
  if (running) {
    return;
  }

  const auth = getGoogleOAuthClient();

  if (!auth.ok) {
    console.log(`Skipping calendar: ${auth.error.message}`);
    return;
  }

  running = true;
  await poll(auth.client);
  timer = setInterval(() => {
    poll(auth.client).catch((error) => console.error(`Calendar poll failed: ${error.message}`));
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
  const calendar = google.calendar({ version: "v3", auth });
  const seen = await readSeen();
  const now = new Date();
  const soon = new Date(now.getTime() + 2 * 60 * 60 * 1000);

  try {
    const response = await calendar.events.list({
      calendarId: "primary",
      timeMin: now.toISOString(),
      timeMax: soon.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 20
    });

    for (const item of response.data.items || []) {
      if (!item.id || seen.includes(item.id)) {
        continue;
      }

      try {
        const event = normalizeEvent(toEvent(item));
        publish(event);
        seen.push(item.id);
      } catch (error) {
        console.error(`Skipping malformed calendar event ${item.id}: ${error.message}`);
      }
    }

    await writeSeen(seen.slice(-MAX_SEEN));
  } catch (error) {
    if (error.code === 401 || error.response?.status === 401) {
      console.error("Calendar authorization failed with 401. The Google refresh token may be revoked.");
      return;
    }

    throw error;
  }
}

function toEvent(item) {
  const start = item.start?.dateTime || item.start?.date;
  const end = item.end?.dateTime || item.end?.date;
  const summary = item.summary || "Calendar event";
  const organizer = item.organizer?.email || "calendar";

  return {
    source: "calendar",
    sourceMessageId: String(item.id),
    threadId: null,
    author: {
      id: organizer,
      displayName: item.organizer?.displayName || organizer
    },
    text: `${summary}\n\nStarts: ${start}\nEnds: ${end}`.slice(0, 2000),
    receivedAt: new Date().toISOString(),
    meta: {
      subject: summary,
      from: organizer,
      labelIds: [],
      start,
      end,
      htmlLink: item.htmlLink || null
    }
  };
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
  const tempFile = path.join(STATE_DIR, `calendar-seen.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tempFile, `${JSON.stringify(ids, null, 2)}\n`, "utf8");
  await rename(tempFile, SEEN_FILE);
}

function runSelfTest() {
  const event = toEvent({
    id: "calendar-item",
    summary: "Demo check-in",
    start: { dateTime: "2026-09-12T10:00:00+05:30" },
    end: { dateTime: "2026-09-12T10:30:00+05:30" },
    organizer: { email: "organizer@example.test", displayName: "Organizer" }
  });
  const passed = event.source === "calendar" && event.text.includes("Demo check-in") && event.meta.start.includes("2026-09-12");

  console.log(`${passed ? "PASS" : "FAIL"} calendar event mapping`);

  if (!passed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runSelfTest();
  process.exit(process.exitCode || 0);
}
