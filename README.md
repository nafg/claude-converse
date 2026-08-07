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

Both the Claude daemon and the Pi extension read the same HOCON file:

```text
${XDG_CONFIG_HOME:-$HOME/.config}/claude-converse/config.conf
```

On first use Converse copies the committed reference [`config.example.conf`](config.example.conf) to that path (mode `0600`) so you never have to find where the plugin is installed — edit the copy, not the reference. The reference is a single annotated file: every provider has its own `stt.<provider>` / `tts.<provider>` block holding its optional overrides and a note on its prerequisites, and blocks for providers you are not using are ignored. Trying another combination normally means moving one `provider` line:

```hocon
stt { provider = "whisper.cpp" }
tts { provider = "speaches-kokoro" }
```

Provider-specific URLs, models, voices, and speeds follow automatically. The file is HOCON with comments; write one setting per line. Unknown dotted settings, incorrect types, and malformed structure fail at startup rather than being silently ignored. Files containing `stt.apiKey` or `tts.apiKey` should remain readable only by their owner; the generated copy is already private.

Changes are loaded when the process starts: use `/converse off` followed by `/converse on` for Claude, or `/reload` for Pi. The daemon and its helper hooks all resolve the same XDG path.

### Independent audio providers

STT and TTS are selected separately. OpenAI uses `gpt-4o-transcribe` for STT and `gpt-4o-mini-tts` with the `alloy` voice for TTS by default. For hosted transcription with local Kokoro speech, configure:

```hocon
stt {
  provider = "openai"
  apiKey = "..."
}
tts { provider = "kokoro" }
```

Reverse the two providers and set `tts.apiKey` for local transcription with OpenAI speech. Setting both providers to local implementations keeps all audio processing on this computer; setting both to `openai` keeps it off this computer. Each hosted key is attached only to its own request. OpenAI providers reject endpoints other than HTTPS URLs on `api.openai.com`, and Groq transcription accepts only its official endpoint.

#### Groq transcription

Groq provides a hosted, OpenAI-compatible transcription endpoint. It can be combined with any TTS provider; see the `stt.groq` block in [`config.example.conf`](config.example.conf). The essential settings for Groq STT with local Kokoro are:

```hocon
stt {
  provider = "groq"
  apiKey = "gsk_..."
  prompt = "Programming and software-development vocabulary"
}
tts { provider = "kokoro" }
```

The endpoint and `whisper-large-v3-turbo` default follow Groq's [speech-to-text documentation](https://console.groq.com/docs/speech-to-text). Converse sends Groq the documented `file`, `model`, `response_format`, `language`, and optional `prompt` multipart fields. To prevent credential leakage, Groq mode accepts only `https://api.groq.com/openai/v1/audio/transcriptions`; its key is never attached to TTS.

Groq's [pricing page](https://groq.com/pricing) states that audio is billed with a ten-second minimum per request. Converse transcribes at detected pauses, so frequent very short utterances can be billed as ten seconds each even though `whisper-large-v3-turbo` has a low hourly rate.

#### Speaches Faster-Whisper transcription

[Speaches](https://github.com/speaches-ai/speaches) exposes Faster-Whisper models through an OpenAI-compatible local API. Select it independently from TTS (the `stt.speaches` block in [`config.example.conf`](config.example.conf)); pairing it with `tts.speaches-kokoro` runs both sides through one Speaches process. The essential settings are:

```hocon
stt {
  provider = "speaches"
  prompt = "Programming and software-development vocabulary"
}
tts { provider = "speaches-kokoro" }
```

The default model follows Speaches' current [speech-to-text guide](https://speaches.ai/usage/speech-to-text/), which uses `Systran/faster-distil-whisper-small.en` as a practical fast English model. Download it before use:

```bash
SPEACHES_BASE_URL=http://localhost:8000 \
  uvx speaches-cli model download Systran/faster-distil-whisper-small.en
```

Speaches publishes separate [CPU and CUDA container instructions](https://speaches.ai/installation/). Its Faster-Whisper settings support `WHISPER__INFERENCE_DEVICE=cpu` or `cuda`; `WHISPER__COMPUTE_TYPE=int8` is a useful CPU-oriented starting point, while CUDA users should benchmark the supported float16 or int8 variants on their own GPU. These configure the external Speaches process, not Converse; Converse only selects its endpoint and model.

Authentication is optional. Set `stt.apiKey` in the Converse config only if the local Speaches server has API-key protection enabled. Authenticated Speaches URLs are restricted to loopback addresses (`localhost`, `127.x.x.x`, or `::1`), the exact `/v1/audio/transcriptions` path, and no URL-embedded credentials. This prevents a typo or remote override from receiving the key. Keyless Speaches may use a custom HTTP(S) host with that exact path, such as a trusted LAN server. The STT key is never attached to TTS.

#### Moonshine Voice transcription

[Moonshine Voice](https://github.com/moonshine-ai/moonshine) is an on-device STT toolkit optimized for live voice applications. Converse uses the official `moonshine-voice` Python package directly; it does not depend on a community HTTP wrapper. Its settings live in the top-level `moonshine { }` block of [`config.example.conf`](config.example.conf); select it with:

```hocon
stt { provider = "moonshine" }
moonshine {
  pythonCommand = "python3"
  language = "en"
  model = "small-streaming"
}
tts { provider = "pocket-tts" }
```

Install the official package into the Python interpreter named by `moonshine.pythonCommand`:

```bash
python3 -m pip install moonshine-voice
```

Converse starts the bundled `services/moonshine-sidecar.py` when voice mode starts. The sidecar calls the official [`get_model_for_language`](https://github.com/moonshine-ai/moonshine/blob/44f8c18dab3f6ab61e2a0a13c22e80f8069d503f/python/src/moonshine_voice/download.py#L410-L435) helper once, keeps one [`Transcriber`](https://github.com/moonshine-ai/moonshine/blob/44f8c18dab3f6ab61e2a0a13c22e80f8069d503f/python/src/moonshine_voice/transcriber.py#L94-L226) resident, and uses `transcribe_without_streaming` for each VAD-delimited PCM utterance. The first start can download model files; increase `runtime.apiTimeoutMs` if that initial download cannot finish within the configured timeout. Pi `/reload` and Claude `/converse off` stop the child process; the next start loads the newly edited configuration and creates a fresh sidecar.

Supported `moonshine.language` values follow the current official Python package: `en`, `es`, `zh`, `ja`, `ko`, `vi`, `ar`, and `uk`. Supported `moonshine.model` values mirror its `ModelArch` enum: `tiny`, `base`, `tiny-streaming`, `base-streaming`, `small-streaming`, and `medium-streaming`; the architectures actually published can vary by language, and startup reports an unavailable combination. Converse defaults to `small-streaming` as a quality/speed starting point, but does not claim local benchmark results; try the available architectures on the target machine. Non-English Moonshine models use the project's Moonshine Community License rather than the English model's MIT license.

`moonshine.sidecarPath` can override the bundled bridge for development or packaging layouts, but normally should be omitted. Moonshine mode accepts no API key and does not send audio over HTTP. The JSONL child protocol correlates concurrent requests, applies the common API timeout, reports Python stderr on crashes, and terminates an unhealthy process after a stuck inference.

This first provider keeps Converse's existing energy VAD and utterance-at-pause behavior. It does not yet feed live microphone frames into Moonshine's streaming API. That deeper partial-transcription architecture remains tracked in Beads issue `claude-converse-i2f`.

#### whisper.cpp transcription

Select the existing OpenAI-compatible `whisper-server` explicitly with:

```hocon
stt {
  provider = "whisper.cpp"
  prompt = "Programming and software-development vocabulary"
}
tts { provider = "local" }
```

The provider never attaches an API key. The server process still controls which model weights are actually loaded; keep its startup model aligned with `stt.model` if the server uses the request field. For English-only dictation, `base.en` is a practical starting point. `small.en` is larger and may trade additional resource use and latency for accuracy. Quantized variants such as `base.en-q5_0` or `small.en-q5_0` reduce model size and can change speed or accuracy depending on the machine, so benchmark them locally rather than assuming one is faster.

`local` is also accepted as an STT provider: the same whisper.cpp endpoint on `localhost:2022`, defaulting to the multilingual `base` model instead of `base.en`.

#### Kokoro speech

Select the existing OpenAI-compatible Kokoro server explicitly with:

```hocon
stt { provider = "whisper.cpp" }
tts { provider = "kokoro" }
```

Kokoro requests are local and never receive an API key. Converse sends one WAV request per speech chunk, which keeps long responses understandable and preserves cancellation between sentences. Speaking over playback follows the same VAD barge-in path as every other TTS provider and aborts in-flight synthesis as well as the active player. `local` is also accepted as an alias for this Kokoro-compatible TTS provider.

#### Speaches Kokoro ONNX speech

Speaches can serve Kokoro through ONNX Runtime on CPU, avoiding the separate PyTorch/CUDA Kokoro process while retaining the same natural voices. Select it independently from STT (the `tts.speaches-kokoro` block in [`config.example.conf`](config.example.conf)); pairing it with `stt.speaches` runs both sides through one Speaches process:

```hocon
stt { provider = "speaches" }
tts { provider = "speaches-kokoro" }
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

Authentication is optional. Configure `tts.apiKey` only when a protected Speaches server runs on loopback. Keyless `speaches-kokoro` may use a trusted LAN HTTP(S) endpoint with the exact `/v1/audio/speech` path; authenticated endpoints are restricted to loopback and URL-embedded credentials are rejected. The TTS key is never attached to STT.

#### Piper speech through Speaches

[Piper](https://github.com/OHF-Voice/piper1-gpl) is the lightweight fallback for systems where predictable CPU use and operational stability matter more than Kokoro's natural prosody. It uses ONNX Runtime through the same Speaches `/v1/audio/speech` API. Piper is fast and very resource-efficient, but its cadence is more synthetic and can be less comfortable than Kokoro for long explanations. Its settings are the `tts.piper` block in [`config.example.conf`](config.example.conf); try it with the existing whisper.cpp server:

```hocon
stt { provider = "whisper.cpp" }
tts { provider = "piper" }
```

The default is the current [Speaches `en_US-lessac-medium` registry model](https://huggingface.co/speaches-ai/piper-en_US-lessac-medium): a single-speaker US English Piper voice at 22.05 kHz. Speaches derives the advertised voice id `lessac` from that model id; the model selects the actual speaker. List available Piper models and download the exact default before starting Converse:

```bash
SPEACHES_BASE_URL=http://localhost:8000 \
  uvx speaches-cli registry ls --task text-to-speech \
  | jq -r '.data[].id | select(test("/piper-"))'

SPEACHES_BASE_URL=http://localhost:8000 \
  uvx speaches-cli model download speaches-ai/piper-en_US-lessac-medium
```

`tts.model`, `tts.voice`, `tts.url`, and `tts.speed` remain configurable because all speech providers share the existing provider-neutral fields. Speaches Piper accepts speed from `0.25` through `4`; higher values speak faster. Converse requests sentence-sized WAV chunks rather than one monolithic long response, so playback remains understandable and VAD barge-in can abort both in-flight synthesis and the active player between or during chunks.

Authentication follows the same safety rules as Speaches Kokoro: `tts.apiKey` is optional, accepted only with a loopback `/v1/audio/speech` URL, and never sent to STT. Keyless Piper may target a trusted LAN Speaches endpoint. Converse selects and calls Piper but does not install, start, restart, or configure the external Speaches service.

#### Official Pocket TTS speech

[Kyutai Pocket TTS](https://github.com/kyutai-labs/pocket-tts) is a small CPU-oriented model aimed at low-latency, natural speech. It is a stronger candidate than Piper when long explanations need comfortable prosody, while keeping the GPU free for transcription. Converse talks directly to the official server API at the pinned implementation used for this adapter: [`POST /tts`](https://github.com/kyutai-labs/pocket-tts/blob/d108410d23eef7e01db282f9442891162dbc3db6/pocket_tts/main.py#L116-L179), not a community OpenAI wrapper.

Its settings are the `tts.pocket-tts` block in [`config.example.conf`](config.example.conf); configure the essential fields:

```hocon
stt { provider = "whisper.cpp" }
tts { provider = "pocket-tts" }
```

Install and run the external server on loopback:

```bash
uvx pocket-tts serve --host localhost --port 8000 --quantize
```

The `--quantize` option enables the official int8 path to reduce CPU memory and can improve speed with minimal quality loss; benchmark it against the unquantized default on this machine. Pocket TTS provides several English voices, and `alba` is the default. Set `tts.voice` to another official built-in voice such as `anna`, or to an HTTP(S)/`hf://` voice prompt accepted by Pocket TTS.

For each sentence-sized speech chunk, Converse sends only the official multipart `text` and `voice_url` fields. It begins piping the chunked WAV response into the configured player as soon as audio arrives rather than buffering the whole response. This preserves time-to-first-audio while sentence chunking and explicit pauses keep long replies understandable. Barge-in aborts the HTTP stream and terminates the active player.

The official server has no API authentication, model selector, or speed field on `/tts`; `tts.apiKey` is rejected, and Converse does not send `tts.model` or `tts.speed`. The adapter accepts only loopback HTTP(S) URLs with the exact `/tts` path and no embedded credentials, query, or fragment. Converse does not install, start, or supervise Pocket TTS.

### Other settings

The config file is the only source of settings; there are no environment-variable
overrides. Every field is optional and lives in a grouped HOCON section — see
[`config.example.conf`](config.example.conf) for the annotated full list. Beyond the
per-provider `stt` / `tts` blocks above:

- `server.host` — default `127.0.0.1`; `server.port` — default `45839`
- `runtime.apiTimeoutMs` — per transcription/speech request; default `60000`
- `stt.timeoutPerAudioSecondMs` `4000` and `stt.timeoutCapMs` `180000` — HTTP transcription timeout scales with utterance length (`apiTimeoutMs` floor); `stt.errorRetries` `1` retries timed-out/failed requests, `stt.emptyTextRetries` `1` retries anomalous empty results on long-enough utterances (both logged, never silent)
- `runtime.voiceWaitMs` — Pi `wait_for_voice` continuation timeout; default `5000`
- `audio.sampleRate` `16000`, `audio.channels` `1`, `audio.bytesPerSample` `2` (only `2`/S16_LE is supported), `audio.frameDurationMs` `30`
- `audio.recorder.command` — default `parecord`; `audio.recorder.device` — default `default` (used by the `arecord` fallback); `audio.recorder.additionalArgs`
- `audio.player.command` — default `paplay`; `audio.player.additionalArgs`
- `status.prefix` — default `🎤 `; `status.separator` — default `" | "`; `status.windowSeconds` `30`; `status.recentMaxEntries` `50`
- `vad.threshold` `300`, `vad.speechStartFrames` `3`, `vad.chunkSilenceFrames` `20`, `vad.utteranceEndFrames` `60` (~1.8 s at the default frame duration), `vad.minUtteranceFrames` `10`, `vad.bargeInEnergyMultiplier` `2.0`, `vad.bargeInFrames` `6`, `vad.preBufferFrames` `10`

Per-provider defaults for URLs, models, voices, and speeds are described in each provider section above; `tts.speed` accepts `0.25`–`4` (Speaches Kokoro ONNX `0.5`–`2`).

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
