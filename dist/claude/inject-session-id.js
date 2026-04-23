#!/usr/bin/env node
import process from "node:process";
const raw = await new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
});
if (!raw.trim())
    process.exit(0);
const payload = JSON.parse(raw);
const command = payload.tool_input?.command ?? "";
const sessionId = payload.session_id ?? "";
if (!command || !sessionId || !command.includes("__CLAUDE_SESSION_ID__"))
    process.exit(0);
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
