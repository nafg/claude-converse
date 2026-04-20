#!/usr/bin/env python3
"""
PreToolUse hook: inject the current session_id into the listener's env.

The voice-mode listener captures CLAUDE_SESSION_ID from its launch env and
writes it to the lock file, so speak.py can match it against the Stop-hook
payload's session_id. Claude Code's own CLAUDE_SESSION_ID comes from the
SessionStart hook via CLAUDE_ENV_FILE, but that chain can go stale for
Monitor-spawned processes that outlive a /clear.

This hook sources session_id directly from its own PreToolUse JSON payload
(Claude Code's authoritative value for the firing session) and prepends it
to the command string via updatedInput. The listener then sees the correct
session_id regardless of any env-var staleness.

Matches only commands that look like the converse listener: path contains
both "claude-converse" and "/skills/converse/listener.py".
"""

import json
import shlex
import sys


def _looks_like_listener(command: str) -> bool:
    return "claude-converse" in command and "/skills/converse/listener.py" in command


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return

    tool_input = payload.get("tool_input") or {}
    command = tool_input.get("command", "")
    if not _looks_like_listener(command):
        return

    session_id = payload.get("session_id", "")
    if not session_id:
        return

    updated_input = dict(tool_input)
    updated_input["command"] = f"CLAUDE_SESSION_ID={shlex.quote(session_id)} {command}"

    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "updatedInput": updated_input,
        }
    }))


if __name__ == "__main__":
    main()
