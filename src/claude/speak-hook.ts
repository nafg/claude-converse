#!/usr/bin/env node
import process from "node:process";
import { loadConfig } from "../core/config.js";

const raw = await new Promise<string>((resolve) => {
  const chunks: Buffer[] = [];
  process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
});
if (!raw.trim()) process.exit(0);

const payload = JSON.parse(raw) as {
  session_id?: string;
  last_assistant_message?: string;
};

const ownerId = payload.session_id ?? "";
const text = payload.last_assistant_message ?? "";
if (!ownerId || !text.trim()) process.exit(0);

const config = loadConfig();
try {
  await fetch(`http://${config.host}:${config.port}/v1/speak`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner_id: ownerId, text }),
  });
} catch {
  // Voice mode is off or the daemon is not ours.
}
