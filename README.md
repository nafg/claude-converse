# claude-converse

Non-blocking, interruptible voice conversation for **Claude Code** and **Pi**.

This branch rebuilds Converse around a shared **TypeScript voice core**:

- **Claude adapter**: runs a localhost HTTP daemon
- **Pi adapter**: runs the same service in-process inside the extension
- **Linux audio tools**: microphone capture via `arecord`, playback via `aplay`
- **STT/TTS backends**: Whisper-compatible HTTP and Kokoro-compatible HTTP

## Current architecture

### Shared core

- `src/core/service.ts` — voice service orchestration
- `src/core/vad.ts` — energy-based VAD state machine
- `src/core/text.ts` — markdown / echo stripping and speech chunking
- `src/core/config.ts` — env-var configuration

### Claude

- `src/claude/daemon.ts` — localhost HTTP daemon (compiled to `dist/claude/daemon.js`)
- `src/claude/inject-session-id.ts` — PreToolUse hook rewrite for `__CLAUDE_SESSION_ID__`
- `src/claude/speak-hook.ts` — Stop hook → `POST /v1/speak`
- `src/claude/shutdown.ts` — explicit daemon shutdown helper
- `skills/converse/SKILL.md` — Claude-side skill instructions
- `skills/converse/statusline-line.sh` — statusline wrapper that fetches already-rendered text from the daemon

### Pi

- `src/pi/index.ts` — in-process Pi extension (compiled to `dist/pi/index.js`)

## Requirements

Linux only for now.

You need:

- Node.js
- `arecord` (usually from `alsa-utils`)
- `aplay` (usually from `alsa-utils`)
- a Whisper-compatible server
- a Kokoro-compatible TTS server

## Configuration

Configuration stays env-var driven.

Common variables:

- `CONVERSE_HOST` — default `127.0.0.1`
- `CONVERSE_PORT` — default `45839`
- `WHISPER_URL` — default `http://localhost:2022/v1/audio/transcriptions`
- `WHISPER_MODEL` — default `base`
- `WHISPER_LANGUAGE` — default `en`
- `WHISPER_INITIAL_PROMPT` — default empty
- `KOKORO_URL` — default `http://localhost:8880/v1/audio/speech`
- `KOKORO_VOICE` — default `af_heart`
- `KOKORO_MODEL` — default `kokoro`
- `CONVERSE_RECORDER_COMMAND` — default `arecord`
- `CONVERSE_RECORDER_DEVICE` — default `default`
- `CONVERSE_PLAYER_COMMAND` — default `aplay`

VAD tuning variables remain available:

- `VAD_THRESHOLD`
- `VAD_SPEECH_START_FRAMES`
- `VAD_CHUNK_SILENCE_FRAMES`
- `VAD_UTTERANCE_END_FRAMES`
- `VAD_MIN_UTTERANCE_FRAMES`
- `VAD_BARGE_IN_ENERGY_MULT`
- `VAD_BARGE_IN_FRAMES`
- `VAD_PRE_BUFFER_FRAMES`

## Claude model

Claude owns the port by starting the daemon explicitly from `/converse on`.

- final transcriptions are consumed via Monitor from `GET /v1/transcriptions/final`
- the Stop hook sends assistant text to `POST /v1/speak`
- statusline fetches pre-rendered text from `GET /v1/status`

The daemon only speaks when the `owner_id` on `/v1/speak` matches the active session.

## Pi model

Pi does **not** spawn a daemon.

The extension runs the same service in-process and binds the same port only as an exclusivity claim. If the port is already in use, voice mode is already active elsewhere.

## Development

Install dependencies:

```bash
npm install
```

Build and run checks:

```bash
npm run build
npm run typecheck
npm test
```
