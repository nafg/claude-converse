# claude-converse

Non-blocking, interruptible voice conversation for **Claude Code** and **Pi**.

This branch rebuilds Converse around a shared **TypeScript voice core**:

- **Claude adapter**: runs a localhost HTTP daemon
- **Pi adapter**: runs the same service in-process inside the extension
- **Linux audio tools**: microphone capture via `parecord`, playback via `paplay` by default
- **Independent STT/TTS backends**: mix local whisper.cpp, Speaches, and Kokoro HTTP with hosted OpenAI or Groq audio APIs

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
- **hosted:** an OpenAI or Groq API key stored in the user config
- **local:** a Whisper-compatible server, a Speaches server, a Kokoro-compatible TTS server, or one of each alongside a hosted provider

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

STT and TTS are selected separately. OpenAI uses `gpt-4o-transcribe` for STT and `gpt-4o-mini-tts` with the `alloy` voice for TTS by default. For hosted transcription with local Kokoro speech, configure:

```json
{
  "sttProvider": "openai",
  "sttApiKey": "...",
  "ttsProvider": "kokoro"
}
```

Reverse the two providers and set `ttsApiKey` for local transcription with OpenAI speech. Setting both providers to local implementations keeps all audio processing on this computer; setting both to `openai` keeps it off this computer. Each hosted key is attached only to its own request. OpenAI providers reject endpoints other than HTTPS URLs on `api.openai.com`, and Groq transcription accepts only its official endpoint.

#### Groq transcription

Groq provides a hosted, OpenAI-compatible transcription endpoint. It can be combined with any TTS provider; see the complete [`config.groq-kokoro.example.json`](config.groq-kokoro.example.json). The essential settings for Groq STT with local Kokoro are:

```json
{
  "sttProvider": "groq",
  "sttApiKey": "gsk_...",
  "whisperUrl": "https://api.groq.com/openai/v1/audio/transcriptions",
  "whisperModel": "whisper-large-v3-turbo",
  "whisperLanguage": "en",
  "whisperPrompt": "Programming and software-development vocabulary",
  "ttsProvider": "kokoro"
}
```

The endpoint and `whisper-large-v3-turbo` default follow Groq's [speech-to-text documentation](https://console.groq.com/docs/speech-to-text). Converse sends Groq the documented `file`, `model`, `response_format`, `language`, and optional `prompt` multipart fields. To prevent credential leakage, Groq mode accepts only `https://api.groq.com/openai/v1/audio/transcriptions`; its key is never attached to TTS.

Groq's [pricing page](https://groq.com/pricing) states that audio is billed with a ten-second minimum per request. Converse transcribes at detected pauses, so frequent very short utterances can be billed as ten seconds each even though `whisper-large-v3-turbo` has a low hourly rate.

#### Speaches Faster-Whisper transcription

[Speaches](https://github.com/speaches-ai/speaches) exposes Faster-Whisper models through an OpenAI-compatible local API. Select it independently from TTS; [`config.speaches-kokoro.example.json`](config.speaches-kokoro.example.json) is a complete local combination. The essential settings are:

```json
{
  "sttProvider": "speaches",
  "whisperUrl": "http://localhost:8000/v1/audio/transcriptions",
  "whisperModel": "Systran/faster-distil-whisper-small.en",
  "whisperLanguage": "en",
  "whisperPrompt": "Programming and software-development vocabulary",
  "ttsProvider": "kokoro"
}
```

The default model follows Speaches' current [speech-to-text guide](https://speaches.ai/usage/speech-to-text/), which uses `Systran/faster-distil-whisper-small.en` as a practical fast English model. Download it before use:

```bash
SPEACHES_BASE_URL=http://localhost:8000 \
  uvx speaches-cli model download Systran/faster-distil-whisper-small.en
```

Speaches publishes separate [CPU and CUDA container instructions](https://speaches.ai/installation/). Its Faster-Whisper settings support `WHISPER__INFERENCE_DEVICE=cpu` or `cuda`; `WHISPER__COMPUTE_TYPE=int8` is a useful CPU-oriented starting point, while CUDA users should benchmark the supported float16 or int8 variants on their own GPU. These configure the external Speaches process, not Converse; Converse only selects its endpoint and model.

Authentication is optional. Set `sttApiKey` in the Converse config only if the local Speaches server has API-key protection enabled. Authenticated Speaches URLs are restricted to loopback addresses (`localhost`, `127.x.x.x`, or `::1`), the exact `/v1/audio/transcriptions` path, and no URL-embedded credentials. This prevents a typo or remote override from receiving the key. Keyless Speaches may use a custom HTTP(S) host with that exact path, such as a trusted LAN server. The STT key is never attached to TTS.

#### whisper.cpp transcription

Select the existing OpenAI-compatible `whisper-server` explicitly with:

```json
{
  "sttProvider": "whisper.cpp",
  "whisperUrl": "http://localhost:2022/v1/audio/transcriptions",
  "whisperModel": "base.en",
  "whisperLanguage": "en",
  "whisperPrompt": "Programming and software-development vocabulary",
  "ttsProvider": "local"
}
```

The provider never attaches an API key. The server process still controls which model weights are actually loaded; keep its startup model aligned with `whisperModel` if the server uses the request field. For English-only dictation, `base.en` is a practical starting point. `small.en` is larger and may trade additional resource use and latency for accuracy. Quantized variants such as `base.en-q5_0` or `small.en-q5_0` reduce model size and can change speed or accuracy depending on the machine, so benchmark them locally rather than assuming one is faster.

`local` remains accepted as the legacy local-STT alias. The former `voiceProvider` and shared `apiKey` file settings also remain accepted for existing installations. Likewise, when no file setting chooses either provider, `CONVERSE_VOICE_PROVIDER` and `OPENAI_API_KEY` retain their coupled legacy behavior.

#### Kokoro speech

Select the existing OpenAI-compatible Kokoro server explicitly with:

```json
{
  "sttProvider": "whisper.cpp",
  "ttsProvider": "kokoro",
  "kokoroUrl": "http://localhost:8880/v1/audio/speech",
  "kokoroModel": "kokoro",
  "kokoroVoice": "af_heart"
}
```

Kokoro requests are local and never receive an API key. Converse sends one WAV request per speech chunk, which keeps long responses understandable and preserves cancellation between sentences. Speaking over playback follows the same VAD barge-in path as every other TTS provider and aborts in-flight synthesis as well as the active player. `local` remains accepted as the legacy Kokoro-compatible TTS alias.

Legacy environment variables and their corresponding file settings:

- `CONVERSE_HOST` → `host` — default `127.0.0.1`
- `CONVERSE_PORT` → `port` — default `45839`
- `CONVERSE_STT_PROVIDER` → `sttProvider` — independently selects `openai`, `groq`, `speaches`, `whisper.cpp`, or the compatibility alias `local` for transcription
- `CONVERSE_TTS_PROVIDER` → `ttsProvider` — independently selects `openai`, `kokoro`, or the compatibility alias `local` for speech
- `OPENAI_STT_API_KEY` → `sttApiKey` — legacy environment fallback used only for OpenAI transcription; set `sttApiKey` in the file for Groq or optional loopback Speaches authentication
- `OPENAI_TTS_API_KEY` → `ttsApiKey` — used only for OpenAI speech
- `CONVERSE_VOICE_PROVIDER` → legacy `voiceProvider` — coupled fallback for both providers
- `OPENAI_API_KEY` → legacy `apiKey` — shared fallback key for existing installations
- `CONVERSE_API_TIMEOUT_MS` → `apiTimeoutMs` — maximum time for each transcription or speech request; default `60000`
- `WHISPER_URL` → `whisperUrl` — transcription URL; defaults to the selected hosted API, `http://localhost:8000/v1/audio/transcriptions` for Speaches, or `http://localhost:2022/v1/audio/transcriptions` for other local providers. Hosted modes restrict URLs to their official HTTPS endpoint; authenticated Speaches is loopback-only.
- `WHISPER_MODEL` → `whisperModel` — defaults to `gpt-4o-transcribe` on OpenAI, `whisper-large-v3-turbo` on Groq, `Systran/faster-distil-whisper-small.en` on Speaches, `base.en` for explicit `whisper.cpp`, or `base` for legacy `local`
- `WHISPER_LANGUAGE` → `whisperLanguage` — default `en`
- `WHISPER_INITIAL_PROMPT` → `whisperPrompt` — default empty
- `KOKORO_URL` → `kokoroUrl` — speech URL; defaults to OpenAI or `http://localhost:8880/v1/audio/speech` for Kokoro-compatible providers
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
