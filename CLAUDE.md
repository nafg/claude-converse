# Converse

Non-blocking, interruptible voice interface for Claude Code.

## Plugin Structure

```
.claude-plugin/plugin.json   — Plugin manifest
skills/converse/SKILL.md     — /converse skill (toggle voice mode)
skills/converse/listener.py  — Mic → energy VAD → Whisper STT → stdout
hooks/hooks.json             — Stop hook config
hooks/speak.py               — TTS via Kokoro + stop hook (JSON or plain text)
```

## Services

- Kokoro TTS: `http://localhost:8880/v1/audio/speech` (OpenAI-compatible)
- Whisper STT: `http://localhost:2022/v1/audio/transcriptions` (whisper.cpp)

## How it works

1. `/converse` starts listener via Monitor (persistent)
2. User speaks → listener kills any TTS (barge-in) → transcribes → stdout → Monitor delivers to Claude
3. Claude responds → Stop hook fires (async) → speak.py reads JSON, extracts message, plays TTS
4. Loop back to 2

## Key details

- speak.py auto-detects JSON (hook mode) vs plain text (manual mode)
- In hook mode: kills existing TTS, runs async (configured in hooks.json)
- PID file and logs stored in $CLAUDE_PLUGIN_DATA (or $XDG_RUNTIME_DIR, or /tmp)
- All paths configurable via environment variables
