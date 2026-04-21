# Converse

> Non-blocking, interruptible voice interface for Claude Code.

Talk to Claude Code while it works. Claude reads its responses aloud, and you can interrupt at any time just by starting to speak — the listener detects your voice, kills the TTS playback, and hands Claude your new input.

## What makes it different

Most "voice for the terminal" setups are turn-based: Claude speaks, you wait, you record, you send. Converse doesn't block. The mic stays open the whole session, Whisper transcribes continuously, and barge-in is handled purely by audio energy — no wake word, no push-to-talk, no modal recording prompt.

## Requirements

- Linux (uses `flock(1)` and `XDG_RUNTIME_DIR`)
- Python 3 with `pyaudio`, `numpy`, `requests`
- A running **Whisper** server (OpenAI-compatible API) on `localhost:2022`
- A running **Kokoro** TTS server (OpenAI-compatible API) on `localhost:8880`

The easiest way to run both is [voicemode](https://github.com/mbailey/voicemode), which installs and manages Whisper + Kokoro locally.

## Installation

```
/plugin install converse@nafg/claude-converse
```

### Required setup

**1. whisper-server needs `--no-context`.**

Without the flag, whisper-server's decoder carries tokens across HTTP requests, so a single bad transcription contaminates every subsequent one until you restart the server. Edit `~/.voicemode/services/whisper/bin/start-whisper-server.sh` and add `--no-context` to the exec line, then `voicemode service restart whisper`. Full details in [CLAUDE.md](./CLAUDE.md#whisper-setup-requirement).

**2. Statusline integration (optional but recommended).**

A small line in your statusline shows live transcriptions while you speak and a mic indicator when voice mode is active. Add the one-liner for your shell to your statusline command — see [CLAUDE.md](./CLAUDE.md#statusline-integration) for the exact snippet.

## Usage

```
/converse on     # start voice mode
/converse off    # stop voice mode
```

Once on, just talk. Claude will:

- Echo your transcription as a blockquote
- Respond in text, which the Stop hook speaks via Kokoro
- Accept interruption: speak over the TTS and it cuts off; the new transcription goes to Claude as normal input

## How it works

```
┌──────────┐   energy VAD    ┌─────────┐   HTTP    ┌─────────┐
│   mic    ├────────────────►│ listener├──────────►│ whisper │
└──────────┘                 └────┬────┘           └─────────┘
                                  │ stdout
                                  ▼
                             ┌─────────┐
                             │ Claude  │
                             └────┬────┘
                                  │ Stop hook
                                  ▼
┌──────────┐   PyAudio       ┌─────────┐   HTTP    ┌─────────┐
│ speakers │◄────────────────│  speak  │◄──────────│ kokoro  │
└──────────┘                 └─────────┘           └─────────┘
```

- **listener.py** runs persistently via Monitor; does energy-based VAD, sends utterances to Whisper, streams transcriptions to Claude.
- **speak.py** runs as a Stop hook; strips markdown, chunks by sentence, streams WAV from Kokoro, plays via PyAudio.
- Barge-in: listener detects sustained loud audio, sends SIGTERM to the TTS process group via a PID file.

## Customization

All configurable via environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `VAD_THRESHOLD` | 300 | RMS energy bar for "is this speech?" |
| `VAD_SPEECH_START_FRAMES` | 3 | Consecutive speech frames before an utterance starts |
| `VAD_CHUNK_SILENCE_FRAMES` | 20 | Short silence triggers status-line update (~600ms) |
| `VAD_UTTERANCE_END_FRAMES` | 50 | Long silence ends the utterance (~1500ms) |
| `VAD_MIN_UTTERANCE_FRAMES` | 10 | Shorter utterances are discarded (~300ms) |
| `VAD_BARGE_IN_ENERGY_MULT` | 2.0 | Barge-in energy bar = THRESHOLD × this |
| `VAD_BARGE_IN_FRAMES` | 6 | Consecutive loud frames required for barge-in |
| `VAD_PRE_BUFFER_FRAMES` | 10 | Frames kept before speech trigger to avoid clipping |
| `KOKORO_URL` | `http://localhost:8880/v1/audio/speech` | TTS endpoint |
| `KOKORO_VOICE` | `af_heart` | Kokoro voice name |
| `KOKORO_MODEL` | `kokoro` | Kokoro model name |
| `WHISPER_URL` | `http://localhost:2022/v1/audio/transcriptions` | STT endpoint |
| `WHISPER_INITIAL_PROMPT` | (empty) | Primes Whisper's decoder with domain vocabulary — a short phrase listing technologies or jargon in play. Dramatically reduces mis-hears on technical terms. |
| `CONVERSE_STATUS_WINDOW` | 30 | Seconds of transcription history to show in statusline |
| `CONVERSE_STATUS_PREFIX` | `🎤 ` | Leading label for statusline output |

## Troubleshooting

- **Transcription echoes itself / cascading repeats**: whisper-server wasn't started with `--no-context`. See the setup notes above. Quick fix: `voicemode service restart whisper`.
- **TTS doesn't play**: `voicemode service restart kokoro`.
- **Nothing happens on `/converse on`**: check Monitor's output for listener errors; most often PyAudio can't find a mic.
- **Barge-in doesn't kill TTS**: look for a stale `tts.pid` in `$XDG_RUNTIME_DIR`. The TTS process probably crashed without cleaning up.

## License

MIT. See [LICENSE](./LICENSE).
