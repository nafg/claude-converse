#!/usr/bin/env node
import process from "node:process";
import { loadConfig } from "../core/config.js";

const ownerId = process.argv[2] ?? process.env.CLAUDE_SESSION_ID ?? "";
if (!ownerId) process.exit(2);
const config = loadConfig();

try {
  const response = await fetch(`http://${config.host}:${config.port}/v1/shutdown`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner_id: ownerId }),
  });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
