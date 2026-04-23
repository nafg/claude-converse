---
name: converse
description: Toggle non-blocking voice conversation on or off
argument-hint: "[on|off]"
---

# Voice Mode Skill

This skill controls the Claude-side converse runtime.

The shared voice engine now lives in a TypeScript service. Claude uses:
- a localhost HTTP daemon for mic/VAD/STT/TTS
- Monitor to consume final transcription lines
- a Stop hook to POST assistant text to the daemon for speech

## When invoked with "on" (or no argument)

1. Start the daemon in the background. Use the literal `__CLAUDE_SESSION_ID__` placeholder in the command. The PreToolUse hook rewrites it to Claude's authoritative session id before execution.

```bash
nohup node "${CLAUDE_PLUGIN_ROOT}/dist/claude/daemon.js" --owner-id=__CLAUDE_SESSION_ID__ >/tmp/claude-converse-daemon.log 2>&1 &
```

2. Start a Monitor task that streams only final transcriptions from the daemon:

```bash
curl -NsS "http://${CONVERSE_HOST:-127.0.0.1}:${CONVERSE_PORT:-45839}/v1/transcriptions/final?owner_id=__CLAUDE_SESSION_ID__"
```

3. Follow the same voice protocol as before:
   - accumulate fragments before responding
   - keep spoken responses concise
   - if you emit a leading `[heard] ... [/heard]` block, the TTS path strips it opportunistically, but do not rely on it being required

## When invoked with "off"

1. Stop the Monitor task.
2. Ask the daemon to shut down for the active session:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/claude/shutdown.js" __CLAUDE_SESSION_ID__
```

3. Resume normal text mode.

## Notes

- Linux only
- Requires `arecord`, `aplay`, Whisper HTTP, and Kokoro HTTP
- Only one active converse owner may exist at a time; startup fails if the port is already in use
