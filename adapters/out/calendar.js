import { fileURLToPath } from "node:url";
import { google } from "googleapis";
import { getGoogleOAuthClient } from "../../core/google.js";

const SLOT_STEP_MINUTES = 15;

export async function createEvent({ summary, start, end, description }) {
  const auth = getGoogleOAuthClient();

  if (!auth.ok) {
    return auth;
  }

  try {
    const calendar = google.calendar({ version: "v3", auth: auth.client });
    const response = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary,
        description,
        start: { dateTime: new Date(start).toISOString() },
        end: { dateTime: new Date(end).toISOString() }
      }
    });

    return { ok: true, eventId: response.data.id };
  } catch (error) {
    return { ok: false, error: { message: error.message, code: error.code || error.response?.status || null } };
  }
}

export async function findFreeSlots(durationMinutes = 30, withinHours = 8) {
  const auth = getGoogleOAuthClient();

  if (!auth.ok) {
    return [];
  }

  try {
    const calendar = google.calendar({ version: "v3", auth: auth.client });
    const now = new Date();
    const endWindow = new Date(now.getTime() + Number(withinHours) * 60 * 60 * 1000);
    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin: now.toISOString(),
        timeMax: endWindow.toISOString(),
        items: [{ id: "primary" }]
      }
    });
    const busy = response.data.calendars?.primary?.busy || [];
    return computeFreeSlots(now, endWindow, busy, Number(durationMinutes));
  } catch (error) {
    console.error(`Calendar freebusy failed: ${error.message}`);
    return [];
  }
}

function computeFreeSlots(startWindow, endWindow, busyBlocks, durationMinutes) {
  const durationMs = Math.max(1, durationMinutes) * 60 * 1000;
  const stepMs = SLOT_STEP_MINUTES * 60 * 1000;
  const busy = busyBlocks
    .map((block) => ({ start: Date.parse(block.start), end: Date.parse(block.end) }))
    .filter((block) => Number.isFinite(block.start) && Number.isFinite(block.end))
    .sort((left, right) => left.start - right.start);
  const slots = [];

  for (let cursor = roundUp(startWindow.getTime(), stepMs); cursor + durationMs <= endWindow.getTime(); cursor += stepMs) {
    const slotEnd = cursor + durationMs;
    const overlaps = busy.some((block) => cursor < block.end && slotEnd > block.start);

    if (!overlaps) {
      slots.push(new Date(cursor).toISOString());
    }
  }

  return slots.slice(0, 10);
}

function roundUp(value, step) {
  return Math.ceil(value / step) * step;
}

function runSelfTest() {
  const slots = computeFreeSlots(
    new Date("2026-09-12T08:00:00.000Z"),
    new Date("2026-09-12T09:00:00.000Z"),
    [{ start: "2026-09-12T08:15:00.000Z", end: "2026-09-12T08:30:00.000Z" }],
    15
  );
  const passed = slots.includes("2026-09-12T08:00:00.000Z") && slots.includes("2026-09-12T08:30:00.000Z") && !slots.includes("2026-09-12T08:15:00.000Z");

  console.log(`${passed ? "PASS" : "FAIL"} calendar free slot calculation`);

  if (!passed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runSelfTest();
  process.exit(process.exitCode || 0);
}
