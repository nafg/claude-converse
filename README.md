# claude-converse

Non-blocking, interruptible voice conversation for **Claude Code** and **Pi**.

This branch rebuilds Converse around a shared **TypeScript voice core**:

- **Claude adapter**: runs a localhost HTTP daemon
- **Pi adapter**: runs the same service in-process inside the extension
- **Linux audio tools**: microphone capture via `parecord`, playback via `paplay` by default
- **STT/TTS backends**: local Whisper/Kokoro HTTP or OpenAI's hosted Audio API (selected automatically when `OPENAI_API_KEY` is available)

## Current architecture

### Shared core

- `src/core/service.ts` — voice service orchestration
- `src/core/vad.ts` — energy-based VAD state machine
- `src/core/text.ts` — markdown / echo stripping and speech chunking
- `src/core/config.ts` — env-var configuration

### Claude

- `src/claude/daemon.ts` — localhost HTTP daemon
- `src/claude/inject-session-id.ts` — PreToolUse hook rewrite for `__CLAUDE_SESSION_ID__`
- `src/claude/speak-hook.ts` — Stop hook → `POST /v1/speak`
- `src/claude/shutdown.ts` — explicit daemon shutdown helper
- `skills/converse/SKILL.md` — Claude-side skill instructions
- `skills/converse/statusline-line.sh` — statusline wrapper that fetches already-rendered text from the daemon

### Pi

- `src/pi/index.ts` — in-process Pi extension

## Requirements

Linux only for now.

You need:

- Node.js
- `parecord` / `paplay` (usually from PulseAudio/PipeWire Pulse tools)
- **recommended:** an `OPENAI_API_KEY`, which uses OpenAI's hosted transcription and TTS APIs and keeps Whisper/Kokoro off this computer
- **or:** a Whisper-compatible server and a Kokoro-compatible TTS server

## Configuration

Configuration stays env-var driven.

### Hosted audio (recommended)

OpenAI is the recommended hosted backend because its Audio API supplies both services this project needs, accepts the existing OpenAI-compatible transcription payload, and returns WAV directly for the existing player. If `OPENAI_API_KEY` is set, Converse **automatically selects it**, so no additional setting is needed. It uses `gpt-4o-transcribe` for STT and `gpt-4o-mini-tts` with the `alloy` voice for TTS.

To opt out and keep all audio processing local, set `CONVERSE_VOICE_PROVIDER=local`. To make the hosted choice explicit, set `CONVERSE_VOICE_PROVIDER=openai`; this requires `OPENAI_API_KEY`.

Common variables:

- `CONVERSE_HOST` — default `127.0.0.1`
- `CONVERSE_PORT` — default `45839`
- `CONVERSE_VOICE_PROVIDER` — `openai` or `local`; defaults to `openai` when `OPENAI_API_KEY` is set, otherwise `local`
- `OPENAI_API_KEY` — enables the hosted OpenAI STT/TTS backend; never stored by Converse
- `CONVERSE_API_TIMEOUT_MS` — maximum time for each transcription or speech request; default `60000`
- `WHISPER_URL` — transcription URL; defaults to OpenAI or `http://localhost:2022/v1/audio/transcriptions` for local. OpenAI mode accepts only `https://api.openai.com` URLs, so its key cannot be sent to an arbitrary override.
- `WHISPER_MODEL` — defaults to `gpt-4o-transcribe` on OpenAI or `base` locally
- `WHISPER_LANGUAGE` — default `en`
- `WHISPER_INITIAL_PROMPT` — default empty
- `KOKORO_URL` — speech URL; defaults to OpenAI or `http://localhost:8880/v1/audio/speech` for local
- `CONVERSE_TTS_VOICE` — defaults to `alloy` on OpenAI or `af_heart` locally (`KOKORO_VOICE` remains a compatibility fallback)
- `KOKORO_MODEL` — defaults to `gpt-4o-mini-tts` on OpenAI or `kokoro` locally
- `CONVERSE_TTS_SPEED` — OpenAI speech speed from `0.25` to `4`; defaults to `1.25` for a more conversational pace
- `CONVERSE_VOICE_WAIT_MS` — maximum time the Pi model's `wait_for_voice` tool waits for continuation of an unfinished thought; default `5000`
- `CONVERSE_RECORDER_COMMAND` — default `parecord`
- `CONVERSE_RECORDER_DEVICE` — default `default` (used only by the `arecord` fallback)
- `CONVERSE_PLAYER_COMMAND` — default `paplay`

VAD tuning variables remain available:

- `VAD_THRESHOLD`
- `VAD_SPEECH_START_FRAMES`
- `VAD_CHUNK_SILENCE_FRAMES`
- `VAD_UTTERANCE_END_FRAMES` — default `60` (~1.8 seconds at the default frame duration)
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

Build before using Claude hooks or the Pi shim:

```bash
npm run build
```

Build and run checks:

```bash
npm run build
npm run typecheck
npm test
```
