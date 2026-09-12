import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import { promisify } from "node:util";
import FormData from "form-data";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { redact } from "../../core/redact.js";

const adapterName = "voice";
const execFile = promisify(execFileCallback);
const temporaryDirectory = resolve("tmp");
const ffmpegAvailable = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const log = {
  debug: (...values) => console.debug(`[${adapterName}]`, ...values),
  warn: (...values) => console.warn(`[${adapterName}]`, ...values),
  error: (...values) => console.error(`[${adapterName}]`, ...values)
};

if (!ffmpegAvailable) log.warn("ffmpeg is not available on PATH; messages will be sent as text.");

/**
 * Send a spoken note, falling back to a plain-text message if audio delivery fails.
 * @param {string} text Text to deliver.
 * @returns {Promise<{ok: boolean, degraded?: boolean, error?: string}>} Delivery result.
 */
export async function sendVoiceNote(text) {
  const message = capText(text);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!token || !chatId) return { ok: false, error: "Telegram credentials are not configured." };

  let mp3Path;
  let oggPath;
  try {
    if (!apiKey) throw new Error("Speech service credentials are not configured.");
    if (!ffmpegAvailable) throw new Error("ffmpeg is unavailable.");
    await mkdir(temporaryDirectory, { recursive: true });
    const fileId = randomUUID();
    mp3Path = resolve(temporaryDirectory, `${fileId}.mp3`);
    oggPath = resolve(temporaryDirectory, `${fileId}.ogg`);
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "alloy", input: redact(message).clean })
    });
    if (!response.ok) throw new Error(`Speech request failed with status ${response.status}.`);
    await writeFile(mp3Path, Buffer.from(await response.arrayBuffer()));
    await execFile("ffmpeg", ["-y", "-i", mp3Path, "-c:a", "libopus", "-b:a", "32k", oggPath]);
    await sendMultipart(token, chatId, oggPath);
    return { ok: true };
  } catch (error) {
    log.warn(`Voice delivery failed: ${error.message}. Sending text instead.`);
    const fallback = await sendText(token, chatId, message);
    return fallback.ok ? { ok: true, degraded: true } : { ok: false, error: fallback.error };
  } finally {
    await Promise.all([mp3Path, oggPath].filter(Boolean).map((path) => rm(path, { force: true }).catch((error) => log.warn(`Could not remove temporary file: ${error.message}`))));
  }
}

function capText(value) {
  const text = String(value ?? "").trim();
  if (text.length <= 500) return text;
  const portion = text.slice(0, 500);
  const boundary = Math.max(portion.lastIndexOf(". "), portion.lastIndexOf("! "), portion.lastIndexOf("? "));
  return (boundary > 0 ? portion.slice(0, boundary + 1) : portion).trim();
}

async function sendMultipart(token, chatId, path) {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("voice", createReadStream(path), { filename: "voice.ogg", contentType: "audio/ogg" });
  const response = await request(`https://api.telegram.org/bot${token}/sendVoice`, form, form.getHeaders());
  if (response.ok !== true) throw new Error(response.description || "Voice upload was rejected.");
}

async function sendText(token, chatId, text) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok !== true) throw new Error(body.description || `Request failed with status ${response.status}.`);
    return { ok: true };
  } catch (error) {
    log.error(`Text fallback failed: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

function request(url, form, headers) {
  return new Promise((resolveRequest, rejectRequest) => {
    const requestHandle = https.request(url, { method: "POST", headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try { resolveRequest(JSON.parse(body)); } catch (error) { rejectRequest(new Error(`Invalid upload response: ${error.message}`)); }
      });
    });
    requestHandle.on("error", rejectRequest);
    form.on("error", rejectRequest);
    form.pipe(requestHandle);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await sendVoiceNote("This is a Valey voice-note self-test.");
  log.debug("Self-test result:", result);
}
