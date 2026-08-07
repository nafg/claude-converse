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

3. Follow the voice protocol for the rest of the session:

   - **Collecting input**: Monitor events are speech transcriptions. Accumulate fragments and wait for a complete thought before responding. Never respond to a single short fragment; treat consecutive events arriving close together as one utterance; fillers and trailing connectors ("um", "so", "and", "but", "like") mean more is coming; only respond to a clear question, request, or complete statement. When in doubt, wait — the user can always prompt again.

   - **Echo transcription**: If you echo back what you heard, wrap the echo between `[transcribed]` and `[/transcribed]` markers at the very start of your reply (inline or on their own lines). Follow these rules strictly:

     1. The block must contain ONLY the transcription of what the user said — never your own commentary, interpretation, or filler.
     2. Anything you want to say goes AFTER the closing `[/transcribed]` tag; the TTS path strips the leading block and speaks only what follows.
     3. A block with nothing after it means "partial input, still accumulating — do not speak". Do not add filler like "waiting for more"; just the block.
     4. The opening `[transcribed]` must be at byte 0 of the message: no leading whitespace, no preamble.
     5. Use the exact literal markers — no HTML tags, alternative bracket shapes, or variant spellings, or the strip fails and the echo is spoken aloud.

   - **Response style**: Keep spoken responses concise and conversational; the user is listening, not reading. Display detailed analysis as text after the spoken summary.

   - **Barge-in**: If a new transcription arrives while you're responding, playback has already been interrupted — treat it as an interruption and address the new input.

## When invoked with "off"

1. Stop the Monitor task.
2. Ask the daemon to shut down for the active session:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/claude/shutdown.js" __CLAUDE_SESSION_ID__
```

3. Resume normal text mode.

## Notes

- Linux only
- Requires `parecord` and `paplay` (or configured compatible commands), plus the STT/TTS services or local packages selected in `~/.config/claude-converse/config.conf`; Converse creates a private commented starter on first use
- Supported choices include local whisper.cpp, Moonshine Voice, Speaches, Kokoro, Piper, and Pocket TTS, or hosted OpenAI/Groq combinations; see the README for setup
- Audio defaults to the OS-selected input/output devices through PulseAudio/PipeWire.
- Only one active converse owner may exist at a time; startup fails if the port is already in use
