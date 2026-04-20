---
name: converse
description: Toggle non-blocking voice conversation on or off
argument-hint: "[on|off]"
---

# Voice Mode Skill

Toggle the voice loop on or off. When on, Claude listens continuously via Monitor, speaks responses via TTS, and supports barge-in interruption.

## When invoked with "on" (or no argument)

1. **Start the listener** via Monitor (persistent). Set `WHISPER_INITIAL_PROMPT` to prime Whisper's decoder with the conversation's domain vocabulary — a short phrase listing the main technologies, projects, or terms in play (e.g. "Python, Scala, Git, PyAudio, whisper-cpp"). Keep it under one sentence. This dramatically reduces mis-hears on technical terms.
   ```
   WHISPER_INITIAL_PROMPT='<domain terms for this conversation>' listener.py
   ```
   If you don't have enough context to write one yet (e.g. a fresh session), start without the env var and restart the listener with a prompt once the conversation focus is clear.

2. **Follow voice mode protocol** for the rest of the session:

   - **Collecting input**: Monitor events from the listener are speech transcriptions. You MUST accumulate fragments and wait for a complete thought before responding. Follow these rules strictly:

     1. **Never respond to a single short fragment** — if the transcription is under ~5 words and doesn't form a clear question or command (e.g., "um", "said it", "well yeah", "so like"), always wait for more.
     2. **Accumulate across events** — treat consecutive events arriving close together as parts of the same utterance. Combine them mentally before deciding whether to respond.
     3. **Fillers and trailing connectors mean more is coming** — words like "um", "uh", "so", "well", "and", "but", "like", "I mean" signal the user is still thinking. Do NOT respond.
     4. **Look for completion signals** — only respond when you see a clear question, request, or complete statement. If in doubt, wait.
     5. **When in doubt, wait** — it is always better to wait too long than to interrupt. The user can always prompt you again if you're too slow, but jumping in early is disruptive.

   - **Echo transcription**: Always echo what the user said as a blockquote (`> ...`) followed by a `---` delimiter.
     - **Partial input** (still accumulating, not ready to respond): Echo the fragment as a blockquote + `---` with nothing after it. This shows the user the transcription is working without triggering TTS. Do NOT add any filler text like "waiting for more" — just the blockquote and delimiter.
     - **Complete input** (ready to respond): Echo the full accumulated input as a blockquote, then `---`, then your response. The Stop hook speaks only what follows the `---`.

   - **Response style**: Keep responses concise and conversational. Short sentences. The user will hear this spoken aloud. Lists are fine but keep items brief.

   - **Barge-in**: If a new transcription arrives while you're generating, the listener has already killed TTS playback. Treat the new transcription as an interruption — acknowledge and respond to the new input.

## When invoked with "off"

1. **Stop the listener** Monitor task using TaskStop
2. **Resume normal text mode**: Stop using the voice protocol (no blockquote echo, no delimiter, normal response length)
3. Confirm voice mode is off

## Troubleshooting

   - **Whisper hallucination**: Previous-request tokens leaking across utterances is prevented by running whisper-server with `--no-context` (see CLAUDE.md setup notes). If you still see cascading repeated transcriptions, `voicemode service restart whisper` clears the state as a fallback.
   - **TTS not responding**: If responses aren't being spoken, run `voicemode service restart kokoro`.

## Notes

- Requires `voicemode` for Whisper STT and Kokoro TTS services
- The Stop hook handles TTS output automatically
- Barge-in works by killing the TTS process group via PID file
- The listener uses energy-based VAD with a 300ms pre-buffer
- Whisper STT runs locally at localhost:2022 (`voicemode service restart whisper` to fix)
- Kokoro TTS runs locally at localhost:8880 (`voicemode service restart kokoro` to fix)
