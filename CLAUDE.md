# Converse internals

## Rewrite overview

Converse has been rebuilt around a shared TypeScript voice core with two harness adapters:

- **Claude**: HTTP daemon on localhost
- **Pi**: in-process extension service

The old Python split (`listener.py`, `speak.py`, `render_status.py`, shell + lockfile coordination) has been removed in favor of:

- one shared service implementation
- one energy-based VAD state machine
- harness-specific transport/adapters only where needed

## Claude transport

Claude keeps the same high-level harness affordances:

- **PreToolUse** rewrite injects the authoritative Claude session id by replacing `__CLAUDE_SESSION_ID__` in commands
- **Monitor** consumes final transcripts from:

```text
GET /v1/transcriptions/final?owner_id=<session>
```

- **Stop hook** sends assistant text to:

```text
POST /v1/speak
```

- **Statusline** fetches already-rendered text from:

```text
GET /v1/status?owner_id=<session>
```

The Claude daemon starts explicitly on `/converse on` and shuts down explicitly on `/converse off`.

## Pi transport

Pi uses the same shared service object directly in-process.

There is no Pi-side daemon. The extension binds the same configured port only to preserve global exclusivity with Claude.

## Exclusivity

`CONVERSE_PORT` is the exclusivity mechanism.

- Claude daemon binds it because it serves HTTP
- Pi binds the same port while voice mode is active
- if bind fails, voice mode is already active elsewhere

## Voice pipeline

1. `parecord` streams raw PCM from the OS-selected default input. Override `CONVERSE_RECORDER_COMMAND=arecord` and `CONVERSE_RECORDER_DEVICE=...` only if needed.
2. `EnergyVad` frames the stream and emits:
   - speech start
   - partial snapshot
   - final snapshot
   - barge-in
3. final snapshots go to Whisper HTTP transcription
4. assistant text goes to Kokoro HTTP synthesis
5. synthesized WAV is played via `paplay` to the OS-selected default output

## TTS cleanup

The service preserves the previous fail-open behavior:

- if a leading `[heard] ... [/heard]` wrapper is well-formed, it is stripped before speech
- if malformed or absent, text is spoken unchanged

So Claude may still use the wrapper, but the runtime never depends on it.
