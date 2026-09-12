import "dotenv/config";
import { subscribe } from "./core/bus.js";
import { decide } from "./core/decide.js";
import { placeCall } from "./adapters/out/call.js";
import { sendSms } from "./adapters/out/sms.js";

const INBOUND_ADAPTERS = [
  {
    name: "telegram",
    path: "./adapters/in/telegram.js",
    requiredEnv: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]
  },
  {
    name: "discord",
    path: "./adapters/in/discord.js",
    requiredEnv: ["DISCORD_BOT_TOKEN"]
  },
  {
    name: "gmail",
    path: "./adapters/in/gmail.js",
    requiredEnv: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"]
  },
  {
    name: "calendar",
    path: "./adapters/in/calendar.js",
    requiredEnv: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"]
  }
];

const startedAdapters = [];

subscribe(async (event) => {
  try {
    const decision = await decide(event);
    await dispatchDecision(decision);
  } catch (error) {
    console.error(`Failed to handle event ${event.id}: ${error.message}`);
  }
});

await startConfiguredAdapters();

process.on("SIGINT", async () => {
  console.log("Stopping Valey...");
  await stopAdapters();
  process.exit(0);
});

async function dispatchDecision(decision) {
  if (decision.channel === "call") {
    const result = await placeCall(callScript(decision));
    logDispatchResult("call", result);
    return;
  }

  if (decision.channel === "sms") {
    const result = await sendSms(notificationText(decision));
    logDispatchResult("sms", result);
    return;
  }

  if (decision.channel === "voice") {
    const result = await sendVoice(notificationText(decision));
    logDispatchResult("voice", result);
    return;
  }

  console.log(`Logged ${decision.tier} event ${decision.eventId}: ${decision.reason}`);
}

async function sendVoice(text) {
  const voice = await import("./adapters/out/voice.js");

  if (typeof voice.sendVoiceNote !== "function") {
    return { ok: false, error: { message: "Voice output is not implemented yet." } };
  }

  return voice.sendVoiceNote(text);
}

async function startConfiguredAdapters() {
  for (const adapterConfig of INBOUND_ADAPTERS) {
    const missing = adapterConfig.requiredEnv.filter((name) => !process.env[name]);

    if (missing.length > 0) {
      console.log(`Skipping ${adapterConfig.name}: missing ${missing.join(", ")}.`);
      continue;
    }

    const adapter = await import(adapterConfig.path);

    if (typeof adapter.start !== "function") {
      console.log(`Skipping ${adapterConfig.name}: adapter start() is not implemented yet.`);
      continue;
    }

    await adapter.start();
    startedAdapters.push({ name: adapterConfig.name, stop: adapter.stop });
    console.log(`Started ${adapterConfig.name}.`);
  }

  if (startedAdapters.length === 0) {
    console.log("Valey started with no inbound adapters active.");
  }
}

async function stopAdapters() {
  for (const adapter of startedAdapters.reverse()) {
    if (typeof adapter.stop !== "function") {
      continue;
    }

    try {
      await adapter.stop();
      console.log(`Stopped ${adapter.name}.`);
    } catch (error) {
      console.error(`Failed to stop ${adapter.name}: ${error.message}`);
    }
  }
}

function callScript(decision) {
  const action = decision.proposedAction ? ` Proposed action: ${decision.proposedAction.summary}. Reply approve to allow it.` : " Reply approve if you want Valey to draft the next step.";
  return `Valey found a critical item. ${decision.reason}.${action}`;
}

function notificationText(decision) {
  const action = decision.proposedAction ? ` Proposed action: ${decision.proposedAction.summary}. Approval required.` : "";
  return `Valey ${decision.tier}: ${decision.reason}.${action}`;
}

function logDispatchResult(channel, result) {
  if (result.ok) {
    console.log(`Dispatched ${channel} notification.`);
    return;
  }

  console.error(`Failed to dispatch ${channel} notification: ${result.error?.message || "unknown error"}`);
}
