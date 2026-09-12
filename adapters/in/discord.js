import { Client, GatewayIntentBits } from "discord.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { normalizeEvent } from "../../core/events.js";
import { publish, subscribe } from "../../core/bus.js";

const adapterName = "discord";
let client = null;
const log = {
  debug: (...values) => console.debug(`[${adapterName}]`, ...values),
  warn: (...values) => console.warn(`[${adapterName}]`, ...values),
  error: (...values) => console.error(`[${adapterName}]`, ...values)
};

/** Connect the client and begin receiving messages. @returns {Promise<void>} Resolves after authentication. */
export async function start() {
  if (client) return;
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return log.error("DISCORD_BOT_TOKEN is not configured.");
  client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  client.on("error", (error) => log.error(`Client error: ${error.message}`));
  client.on("warn", (warning) => log.warn(warning));
  client.on("shardDisconnect", (event, shardId) => log.warn(`Shard ${shardId} disconnected (${event.code}).`));
  client.on("messageCreate", (message) => void handleMessage(message));
  try {
    await client.login(token);
  } catch (error) {
    log.error(`Login failed: ${error.message}`);
    client.destroy();
    client = null;
  }
}

/** Disconnect the client. @returns {Promise<void>} Resolves after shutdown. */
export async function stop() {
  if (!client) return;
  try { client.destroy(); } catch (error) { log.warn(`Shutdown error: ${error.message}`); } finally { client = null; }
}

async function handleMessage(message) {
  try {
    if (message.author?.bot === true) return;
    const text = cleanContent(message);
    if (!text) {
      log.debug(`Skipped attachment-only message (${message.attachments?.size ?? 0} attachments).`);
      return;
    }
    const authorId = String(message.author?.id ?? "unknown");
    const displayName = message.author?.globalName ?? message.author?.username ?? authorId ?? "unknown";
    const event = normalizeEvent({
      source: "discord", sourceMessageId: String(message.id), threadId: String(message.channelId),
      author: { id: authorId, displayName: String(displayName || authorId || "unknown") }, text,
      receivedAt: message.createdAt.toISOString(),
      meta: { guildId: message.guildId ?? null, channelName: message.channel?.name ?? null }
    });
    publish(event);
  } catch (error) { log.warn(`Skipped malformed message: ${error.message}`); }
}

function cleanContent(message) {
  return String(message.content ?? "")
    .replace(/<@!?(\d+)>/g, (mention, id) => {
      const user = message.mentions?.users?.get(id) ?? client?.users.cache.get(id);
      return user?.username ? `@${user.username}` : mention;
    })
    .replace(/<#(\d+)>/g, (mention, id) => {
      const channel = message.mentions?.channels?.get(id) ?? message.guild?.channels.cache.get(id) ?? client?.channels.cache.get(id);
      return channel?.name ? `#${channel.name}` : mention;
    })
    .replace(/<a?:([^:>]+):\d+>/g, ":$1:").trim();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  subscribe((event) => log.debug("Normalized event:", event));
  await start();
}
