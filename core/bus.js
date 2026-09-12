import { EventEmitter } from "node:events";
import { normalizeEvent } from "./events.js";

const bus = new EventEmitter();

export function publish(event) {
  let normalized;

  try {
    normalized = normalizeEvent(event);
  } catch (error) {
    console.error(`Rejected invalid event: ${error.message}`);
    return false;
  }

  bus.emit("event", normalized);
  return true;
}

export function subscribe(handler) {
  bus.on("event", handler);
  return () => bus.off("event", handler);
}
