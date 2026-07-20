# claude-converse

Non-blocking, interruptible voice conversation for **Claude Code** and **Pi**.

This branch rebuilds Converse around a shared **TypeScript voice core**:

- **Claude adapter**: runs a localhost HTTP daemon
- **Pi adapter**: runs the same service in-process inside the extension
- **Linux audio tools**: microphone capture via `parecord`, playback via `paplay` by default
- **Independent STT/TTS backends**: mix local whisper.cpp, Moonshine, Speaches, Kokoro, Piper, or Pocket TTS with hosted OpenAI or Groq audio APIs

## Current architecture

### Shared core

- `src/core/service.ts` — voice service orchestration
- `src/core/vad.ts` — energy-based VAD state machine
- `src/core/text.ts` — markdown / echo stripping and speech chunking
- `src/core/config.ts` — shared JSON configuration

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
- **local:** a Whisper-compatible server, the official Moonshine Voice Python package, a Speaches server (Faster-Whisper, Kokoro ONNX, or Piper), a Kokoro-compatible TTS server, the official Pocket TTS server, or one of each alongside a hosted provider

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
  "ttsProvider": "speaches-kokoro",
  "kokoroUrl": "http://localhost:8000/v1/audio/speech",
  "kokoroModel": "speaches-ai/Kokoro-82M-v1.0-ONNX",
  "kokoroVoice": "af_heart"
}
```

The default model follows Speaches' current [speech-to-text guide](https://speaches.ai/usage/speech-to-text/), which uses `Systran/faster-distil-whisper-small.en` as a practical fast English model. Download it before use:

```bash
SPEACHES_BASE_URL=http://localhost:8000 \
  uvx speaches-cli model download Systran/faster-distil-whisper-small.en
```

Speaches publishes separate [CPU and CUDA container instructions](https://speaches.ai/installation/). Its Faster-Whisper settings support `WHISPER__INFERENCE_DEVICE=cpu` or `cuda`; `WHISPER__COMPUTE_TYPE=int8` is a useful CPU-oriented starting point, while CUDA users should benchmark the supported float16 or int8 variants on their own GPU. These configure the external Speaches process, not Converse; Converse only selects its endpoint and model.

Authentication is optional. Set `sttApiKey` in the Converse config only if the local Speaches server has API-key protection enabled. Authenticated Speaches URLs are restricted to loopback addresses (`localhost`, `127.x.x.x`, or `::1`), the exact `/v1/audio/transcriptions` path, and no URL-embedded credentials. This prevents a typo or remote override from receiving the key. Keyless Speaches may use a custom HTTP(S) host with that exact path, such as a trusted LAN server. The STT key is never attached to TTS.

#### Moonshine Voice transcription

[Moonshine Voice](https://github.com/moonshine-ai/moonshine) is an on-device STT toolkit optimized for live voice applications. Converse uses the official `moonshine-voice` Python package directly; it does not depend on a community HTTP wrapper. Use the complete [`config.moonshine-pocket-tts.example.json`](config.moonshine-pocket-tts.example.json), or select it with:

```json
{
  "sttProvider": "moonshine",
  "moonshinePythonCommand": "python3",
  "moonshineLanguage": "en",
  "moonshineModel": "small-streaming",
  "ttsProvider": "pocket-tts"
}
```

Install the official package into the Python interpreter named by `moonshinePythonCommand`:

```bash
python3 -m pip install moonshine-voice
```

Converse starts the bundled `services/moonshine-sidecar.py` when voice mode starts. The sidecar calls the official [`get_model_for_language`](https://github.com/moonshine-ai/moonshine/blob/44f8c18dab3f6ab61e2a0a13c22e80f8069d503f/python/src/moonshine_voice/download.py#L410-L435) helper once, keeps one [`Transcriber`](https://github.com/moonshine-ai/moonshine/blob/44f8c18dab3f6ab61e2a0a13c22e80f8069d503f/python/src/moonshine_voice/transcriber.py#L94-L226) resident, and uses `transcribe_without_streaming` for each VAD-delimited PCM utterance. The first start can download model files; increase `apiTimeoutMs` if that initial download cannot finish within the configured timeout. Pi `/reload` and Claude `/converse off` stop the child process; the next start loads the newly edited configuration and creates a fresh sidecar.

Supported `moonshineLanguage` values follow the current official Python package: `en`, `es`, `zh`, `ja`, `ko`, `vi`, `ar`, and `uk`. Supported `moonshineModel` values mirror its `ModelArch` enum: `tiny`, `base`, `tiny-streaming`, `base-streaming`, `small-streaming`, and `medium-streaming`; the architectures actually published can vary by language, and startup reports an unavailable combination. Converse defaults to `small-streaming` as a quality/speed starting point, but does not claim local benchmark results; try the available architectures on the target machine. Non-English Moonshine models use the project's Moonshine Community License rather than the English model's MIT license.

`moonshineSidecarPath` can override the bundled bridge for development or packaging layouts, but normally should be omitted. Moonshine mode accepts no API key and does not send audio over HTTP. The JSONL child protocol correlates concurrent requests, applies the common API timeout, reports Python stderr on crashes, and terminates an unhealthy process after a stuck inference.

This first provider keeps Converse's existing energy VAD and utterance-at-pause behavior. It does not yet feed live microphone frames into Moonshine's streaming API. That deeper partial-transcription architecture remains tracked in Beads issue `claude-converse-i2f`.

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

#### Speaches Kokoro ONNX speech

Speaches can serve Kokoro through ONNX Runtime on CPU, avoiding the separate PyTorch/CUDA Kokoro process while retaining the same natural voices. Select it independently from STT, or use the complete [`config.speaches-kokoro.example.json`](config.speaches-kokoro.example.json) to run both sides through one Speaches process:

```json
{
  "sttProvider": "speaches",
  "ttsProvider": "speaches-kokoro",
  "kokoroUrl": "http://localhost:8000/v1/audio/speech",
  "kokoroModel": "speaches-ai/Kokoro-82M-v1.0-ONNX",
  "kokoroVoice": "af_heart",
  "ttsSpeed": 1.25
}
```

Use Speaches' CPU deployment and download the model before starting Converse:

```bash
docker run --rm --detach --publish 8000:8000 \
  --name speaches \
  --volume hf-hub-cache:/home/ubuntu/.cache/huggingface/hub \
  ghcr.io/speaches-ai/speaches:latest-cpu

SPEACHES_BASE_URL=http://localhost:8000 \
  uvx speaches-cli model download speaches-ai/Kokoro-82M-v1.0-ONNX
```

Speaches unloads TTS models after 300 seconds by default. Its external `TTS_MODEL_TTL` setting controls that behavior: keep the default to recover memory while idle, or set `TTS_MODEL_TTL=-1` to avoid reload latency during an active voice-work session. Converse does not start or manage Speaches. It requests WAV chunks, includes the configured speed (Speaches accepts `0.5` through `2`), and retains the common sentence chunking, cancellation, playback, and VAD barge-in behavior for long replies.

Authentication is optional. Configure `ttsApiKey` only when a protected Speaches server runs on loopback. Keyless `speaches-kokoro` may use a trusted LAN HTTP(S) endpoint with the exact `/v1/audio/speech` path; authenticated endpoints are restricted to loopback and URL-embedded credentials are rejected. The TTS key is never attached to STT.

#### Piper speech through Speaches

[Piper](https://github.com/OHF-Voice/piper1-gpl) is the lightweight fallback for systems where predictable CPU use and operational stability matter more than Kokoro's natural prosody. It uses ONNX Runtime through the same Speaches `/v1/audio/speech` API. Piper is fast and very resource-efficient, but its cadence is more synthetic and can be less comfortable than Kokoro for long explanations. Use the complete [`config.piper.example.json`](config.piper.example.json) to try it with the existing whisper.cpp server:

```json
{
  "sttProvider": "whisper.cpp",
  "ttsProvider": "piper",
  "kokoroUrl": "http://localhost:8000/v1/audio/speech",
  "kokoroModel": "speaches-ai/piper-en_US-lessac-medium",
  "kokoroVoice": "lessac",
  "ttsSpeed": 1.25
}
```

The default is the current [Speaches `en_US-lessac-medium` registry model](https://huggingface.co/speaches-ai/piper-en_US-lessac-medium): a single-speaker US English Piper voice at 22.05 kHz. Speaches derives the advertised voice id `lessac` from that model id; the model selects the actual speaker. List available Piper models and download the exact default before starting Converse:

```bash
SPEACHES_BASE_URL=http://localhost:8000 \
  uvx speaches-cli registry ls --task text-to-speech \
  | jq -r '.data[].id | select(test("/piper-"))'

SPEACHES_BASE_URL=http://localhost:8000 \
  uvx speaches-cli model download speaches-ai/piper-en_US-lessac-medium
```

`kokoroModel`, `kokoroVoice`, `kokoroUrl`, and `ttsSpeed` remain configurable because all speech providers share the existing provider-neutral fields. Speaches Piper accepts speed from `0.25` through `4`; higher values speak faster. Converse requests sentence-sized WAV chunks rather than one monolithic long response, so playback remains understandable and VAD barge-in can abort both in-flight synthesis and the active player between or during chunks.

Authentication follows the same safety rules as Speaches Kokoro: `ttsApiKey` is optional, accepted only with a loopback `/v1/audio/speech` URL, and never sent to STT. Keyless Piper may target a trusted LAN Speaches endpoint. Converse selects and calls Piper but does not install, start, restart, or configure the external Speaches service.

#### Official Pocket TTS speech

[Kyutai Pocket TTS](https://github.com/kyutai-labs/pocket-tts) is a small CPU-oriented model aimed at low-latency, natural speech. It is a stronger candidate than Piper when long explanations need comfortable prosody, while keeping the GPU free for transcription. Converse talks directly to the official server API at the pinned implementation used for this adapter: [`POST /tts`](https://github.com/kyutai-labs/pocket-tts/blob/d108410d23eef7e01db282f9442891162dbc3db6/pocket_tts/main.py#L116-L179), not a community OpenAI wrapper.

Use the complete [`config.pocket-tts.example.json`](config.pocket-tts.example.json), or configure the essential fields:

```json
{
  "sttProvider": "whisper.cpp",
  "ttsProvider": "pocket-tts",
  "kokoroUrl": "http://localhost:8000/tts",
  "kokoroVoice": "alba"
}
```

Install and run the external server on loopback:

```bash
uvx pocket-tts serve --host localhost --port 8000 --quantize
```

The `--quantize` option enables the official int8 path to reduce CPU memory and can improve speed with minimal quality loss; benchmark it against the unquantized default on this machine. Pocket TTS provides several English voices, and `alba` is the default. Set `kokoroVoice` to another official built-in voice such as `anna`, or to an HTTP(S)/`hf://` voice prompt accepted by Pocket TTS. The provider-neutral field name is retained for config compatibility.

For each sentence-sized speech chunk, Converse sends only the official multipart `text` and `voice_url` fields. It begins piping the chunked WAV response into the configured player as soon as audio arrives rather than buffering the whole response. This preserves time-to-first-audio while sentence chunking and explicit pauses keep long replies understandable. Barge-in aborts the HTTP stream and terminates the active player.

The official server has no API authentication, model selector, or speed field on `/tts`; `ttsApiKey` is rejected, and Converse does not send `kokoroModel` or `ttsSpeed`. The adapter accepts only loopback HTTP(S) URLs with the exact `/tts` path and no embedded credentials, query, or fragment. Converse does not install, start, or supervise Pocket TTS.

Legacy environment variables and their corresponding file settings:

- `CONVERSE_HOST` → `host` — default `127.0.0.1`
- `CONVERSE_PORT` → `port` — default `45839`
- `CONVERSE_STT_PROVIDER` → `sttProvider` — independently selects `openai`, `groq`, `speaches`, `whisper.cpp`, or the compatibility alias `local` for transcription
- `CONVERSE_TTS_PROVIDER` → `ttsProvider` — independently selects `openai`, `kokoro`, `piper`, `pocket-tts`, `speaches-kokoro`, or the compatibility alias `local` for speech
- `OPENAI_STT_API_KEY` → `sttApiKey` — legacy environment fallback used only for OpenAI transcription; set `sttApiKey` in the file for Groq or optional loopback Speaches authentication
- `OPENAI_TTS_API_KEY` → `ttsApiKey` — legacy environment fallback used only for OpenAI speech; set `ttsApiKey` in the file for optional loopback Speaches Kokoro or Piper authentication
- `CONVERSE_VOICE_PROVIDER` → legacy `voiceProvider` — coupled fallback for both providers
- `OPENAI_API_KEY` → legacy `apiKey` — shared fallback key for existing installations
- `CONVERSE_API_TIMEOUT_MS` → `apiTimeoutMs` — maximum time for each transcription or speech request; default `60000`
- `WHISPER_URL` → `whisperUrl` — transcription URL; defaults to the selected hosted API, `http://localhost:8000/v1/audio/transcriptions` for Speaches, or `http://localhost:2022/v1/audio/transcriptions` for other local providers. Hosted modes restrict URLs to their official HTTPS endpoint; authenticated Speaches is loopback-only.
- `WHISPER_MODEL` → `whisperModel` — defaults to `gpt-4o-transcribe` on OpenAI, `whisper-large-v3-turbo` on Groq, `Systran/faster-distil-whisper-small.en` on Speaches, `base.en` for explicit `whisper.cpp`, or `base` for legacy `local`
- `WHISPER_LANGUAGE` → `whisperLanguage` — default `en`
- `WHISPER_INITIAL_PROMPT` → `whisperPrompt` — default empty
- `KOKORO_URL` → `kokoroUrl` — speech URL; defaults to OpenAI, `http://localhost:8000/v1/audio/speech` for Speaches Kokoro ONNX or Piper, `http://localhost:8000/tts` for official Pocket TTS, or `http://localhost:8880/v1/audio/speech` for other Kokoro-compatible providers
- `CONVERSE_TTS_VOICE` → `kokoroVoice` — defaults to `alloy` on OpenAI, `lessac` on Piper, `alba` on Pocket TTS, or `af_heart` on Kokoro-compatible providers (`KOKORO_VOICE` remains a compatibility fallback)
- `KOKORO_MODEL` → `kokoroModel` — defaults to `gpt-4o-mini-tts` on OpenAI, `speaches-ai/Kokoro-82M-v1.0-ONNX` on Speaches Kokoro ONNX, `speaches-ai/piper-en_US-lessac-medium` on Piper, `pocket-tts` as a compatibility label for Pocket TTS, or `kokoro` locally; the official Pocket API does not receive this field
- `CONVERSE_TTS_SPEED` → `ttsSpeed` — OpenAI and Speaches Piper accept `0.25` to `4`; Speaches Kokoro ONNX accepts `0.5` to `2`; default `1.25`; the official Pocket API does not receive this field
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
