#!/usr/bin/env node
import process from "node:process";

const raw = await new Promise<string>((resolve) => {
  const chunks: Buffer[] = [];
  process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
});

if (!raw.trim()) process.exit(0);

let payload: {
  session_id?: string;
  tool_input?: { command?: string };
};

try {
  payload = JSON.parse(raw) as {
    session_id?: string;
    tool_input?: { command?: string };
  };
} catch {
  process.exit(0);
}

const command = payload.tool_input?.command ?? "";
const sessionId = payload.session_id ?? "";
if (!command || !sessionId || !command.includes("__CLAUDE_SESSION_ID__")) process.exit(0);

const updatedInput = {
  ...(payload.tool_input ?? {}),
  command: command.replaceAll("__CLAUDE_SESSION_ID__", sessionId),
};

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    updatedInput,
  },
}));
