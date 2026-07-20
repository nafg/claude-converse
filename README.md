# claude-converse

Non-blocking, interruptible voice conversation for **Claude Code** and **Pi**.

This branch rebuilds Converse around a shared **TypeScript voice core**:

- **Claude adapter**: runs a localhost HTTP daemon
- **Pi adapter**: runs the same service in-process inside the extension
- **Linux audio tools**: microphone capture via `parecord`, playback via `paplay` by default
- **Independent STT/TTS backends**: mix local Whisper/Kokoro HTTP with OpenAI's hosted Audio API

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
- **hosted:** an OpenAI API key stored in the user config
- **local:** a Whisper-compatible server, a Kokoro-compatible TTS server, or one of each alongside OpenAI

## Configuration

Both the Claude daemon and the Pi extension read the same JSON file:

```text
${XDG_CONFIG_HOME:-$HOME/.config}/claude-converse/config.json
```

Create it from the complete [`config.example.json`](config.example.json):

```bash
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/claude-converse"
cp config.example.json "${XDG_CONFIG_HOME:-$HOME/.config}/claude-converse/config.json"
```

Every setting is optional. Missing files and omitted settings use the defaults below. Explicit file settings take precedence over legacy environment variables, so the file alone is sufficient. Unknown keys, incorrect types, and malformed JSON fail at startup instead of being silently ignored. Because `sttApiKey` and `ttsApiKey` are secrets, keep a config containing them readable only by your user (for example, `chmod 600 config.json`).

Changes are loaded when the process starts: use `/converse off` followed by `/converse on` for Claude, or `/reload` for Pi. The daemon and its helper hooks all resolve the same XDG path.

### Independent audio providers

STT and TTS are selected separately. OpenAI uses `gpt-4o-transcribe` for STT and `gpt-4o-mini-tts` with the `alloy` voice for TTS by default. For hosted transcription with local speech, configure:

```json
{
  "sttProvider": "openai",
  "sttApiKey": "...",
  "ttsProvider": "local"
}
```

Reverse the two providers and set `ttsApiKey` for local transcription with OpenAI speech. Setting both providers to `local` keeps all audio processing on this computer; setting both to `openai` keeps it off this computer. Each OpenAI key is attached only to its own request, and OpenAI providers reject endpoints other than HTTPS URLs on `api.openai.com`.

The former `voiceProvider` and shared `apiKey` file settings remain accepted for existing installations. Likewise, when no file setting chooses either provider, `CONVERSE_VOICE_PROVIDER` and `OPENAI_API_KEY` retain their coupled legacy behavior.

Legacy environment variables and their corresponding file settings:

- `CONVERSE_HOST` → `host` — default `127.0.0.1`
- `CONVERSE_PORT` → `port` — default `45839`
- `CONVERSE_STT_PROVIDER` → `sttProvider` — independently selects `openai` or `local` transcription
- `CONVERSE_TTS_PROVIDER` → `ttsProvider` — independently selects `openai` or `local` speech
- `OPENAI_STT_API_KEY` → `sttApiKey` — used only for OpenAI transcription
- `OPENAI_TTS_API_KEY` → `ttsApiKey` — used only for OpenAI speech
- `CONVERSE_VOICE_PROVIDER` → legacy `voiceProvider` — coupled fallback for both providers
- `OPENAI_API_KEY` → legacy `apiKey` — shared fallback key for existing installations
- `CONVERSE_API_TIMEOUT_MS` → `apiTimeoutMs` — maximum time for each transcription or speech request; default `60000`
- `WHISPER_URL` → `whisperUrl` — transcription URL; defaults to OpenAI or `http://localhost:2022/v1/audio/transcriptions` for local. OpenAI mode accepts only `https://api.openai.com` URLs, so its key cannot be sent to an arbitrary override.
- `WHISPER_MODEL` → `whisperModel` — defaults to `gpt-4o-transcribe` on OpenAI or `base` locally
- `WHISPER_LANGUAGE` → `whisperLanguage` — default `en`
- `WHISPER_INITIAL_PROMPT` → `whisperPrompt` — default empty
- `KOKORO_URL` → `kokoroUrl` — speech URL; defaults to OpenAI or `http://localhost:8880/v1/audio/speech` for local
- `CONVERSE_TTS_VOICE` → `kokoroVoice` — defaults to `alloy` on OpenAI or `af_heart` locally (`KOKORO_VOICE` remains a compatibility fallback)
- `KOKORO_MODEL` → `kokoroModel` — defaults to `gpt-4o-mini-tts` on OpenAI or `kokoro` locally
- `CONVERSE_TTS_SPEED` → `ttsSpeed` — OpenAI speech speed from `0.25` to `4`; defaults to `1.25` for a more conversational pace
- `CONVERSE_VOICE_WAIT_MS` → `voiceWaitMs` — maximum time the Pi model's `wait_for_voice` tool waits for continuation of an unfinished thought; default `5000`
- `CONVERSE_RECORDER_COMMAND` → `recorderCommand` — default `parecord`
- `CONVERSE_RECORDER_DEVICE` → `recorderDevice` — default `default` (used only by the `arecord` fallback)
- `CONVERSE_PLAYER_COMMAND` → `playerCommand` — default `paplay`

VAD tuning variables remain available:

- `VAD_THRESHOLD` → `vadThreshold`
- `VAD_SPEECH_START_FRAMES` → `vadSpeechStartFrames`
- `VAD_CHUNK_SILENCE_FRAMES` → `vadChunkSilenceFrames`
- `VAD_UTTERANCE_END_FRAMES` → `vadUtteranceEndFrames` — default `60` (~1.8 seconds at the default frame duration)
- `VAD_MIN_UTTERANCE_FRAMES` → `vadMinUtteranceFrames`
- `VAD_BARGE_IN_ENERGY_MULT` → `vadBargeInEnergyMultiplier`
- `VAD_BARGE_IN_FRAMES` → `vadBargeInFrames`
- `VAD_PRE_BUFFER_FRAMES` → `vadPreBufferFrames`

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
