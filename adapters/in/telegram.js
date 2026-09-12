import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeEvent } from "../../core/events.js";
import { publish, subscribe } from "../../core/bus.js";

const adapterName = "telegram";
const offsetPath = resolve("state", "telegram-offset.json");
let polling = false;
let controller = null;

const log = {
  debug: (...values) => console.debug(`[${adapterName}]`, ...values),
  warn: (...values) => console.warn(`[${adapterName}]`, ...values),
  error: (...values) => console.error(`[${adapterName}]`, ...values)
};

/** Start long-polling incoming messages. @returns {Promise<void>} Resolves after polling starts. */
export async function start() {
  if (polling) return;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return log.error("TELEGRAM_BOT_TOKEN is not configured.");
  polling = true;
  void poll(token);
}

/** Stop long-polling and abort an in-flight request. @returns {Promise<void>} Resolves after stopping. */
export async function stop() {
  polling = false;
  controller?.abort();
  controller = null;
}

async function poll(token) {
  let offset = await loadOffset();
  let backoffMs = 1000;
  while (polling) {
    try {
      controller = new AbortController();
      const url = new URL(`https://api.telegram.org/bot${token}/getUpdates`);
      url.searchParams.set("timeout", "30");
      if (offset !== null) url.searchParams.set("offset", String(offset));
      const response = await fetch(url, { signal: controller.signal });
      const body = await response.json().catch(() => ({}));
      controller = null;
      if (response.status === 429) {
        const retryAfter = Number(body?.parameters?.retry_after);
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs;
        log.warn(`Rate limited; retrying in ${Math.ceil(waitMs / 1000)} seconds.`);
        await delay(waitMs);
        backoffMs = Math.min(backoffMs * 2, 30000);
        continue;
      }
      if (!response.ok || body?.ok !== true || !Array.isArray(body.result)) {
        throw new Error(body?.description || `Request failed with status ${response.status}`);
      }
      backoffMs = 1000;
      for (const update of body.result) {
        const nextOffset = Number(update.update_id) + 1;
        if (Number.isFinite(nextOffset)) {
          offset = nextOffset;
          await saveOffset(offset);
        }
        await handleUpdate(update);
      }
    } catch (error) {
      controller = null;
      if (!polling || error?.name === "AbortError") break;
      log.warn(`Polling error: ${error.message}. Retrying in ${Math.ceil(backoffMs / 1000)} seconds.`);
      await delay(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30000);
    }
  }
}

async function handleUpdate(update) {
  const message = update?.message;
  if (!message || message.from?.is_bot === true) return;
  if (typeof message.text !== "string") {
    const type = Object.keys(message).find((key) => !["message_id", "date", "chat", "from"].includes(key)) ?? "unknown";
    log.debug(`Skipped non-text message (${type}).`);
    return;
  }
  try {
    const from = message.from ?? {};
    const authorId = String(from.id ?? "unknown");
    const fullName = [from.first_name, from.last_name].filter((part) => typeof part === "string" && part.trim()).join(" ").trim();
    const displayName = fullName || from.username || authorId || "unknown";
    const event = normalizeEvent({
      source: "telegram",
      sourceMessageId: String(message.message_id),
      threadId: String(message.chat?.id),
      author: { id: authorId, displayName: String(displayName) },
      text: message.text,
      receivedAt: new Date(message.date * 1000).toISOString(),
      meta: { chatType: message.chat?.type ?? "unknown", username: message.from?.username ?? null }
    });
    publish(event);
  } catch (error) {
    log.warn(`Skipped malformed message: ${error.message}`);
  }
}

async function loadOffset() {
  try {
    const stored = JSON.parse(await readFile(offsetPath, "utf8"));
    return Number.isInteger(stored.offset) ? stored.offset : null;
  } catch (error) {
    if (error.code !== "ENOENT") log.warn(`Could not read offset: ${error.message}`);
    return null;
  }
}

async function saveOffset(offset) {
  try {
    await mkdir(dirname(offsetPath), { recursive: true });
    const temporary = `${offsetPath}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ offset })}\n`, "utf8");
    await rename(temporary, offsetPath);
  } catch (error) {
    log.warn(`Could not persist offset: ${error.message}`);
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  subscribe((event) => log.debug("Normalized event:", event));
  await start();
}
