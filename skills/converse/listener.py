#!/usr/bin/env python3
"""
Voice loop listener — runs via Monitor.

Continuously records from the microphone, detects speech boundaries using
energy-based VAD, kills TTS on speech start (barge-in), and prints
transcriptions to stdout for Monitor to deliver to Claude.

stdout format: one line per transcription (Monitor delivers each line as a notification).
stderr: logging (goes to Monitor's output file, not to Claude).
"""

import fcntl
import io
import os
import signal
import sys
import threading
import time
import wave

import numpy as np
import pyaudio
import requests

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SAMPLE_RATE = 16000
CHANNELS = 1
FORMAT = pyaudio.paInt16
FRAME_DURATION_MS = 30
FRAME_SIZE = int(SAMPLE_RATE * FRAME_DURATION_MS / 1000)  # 480 samples

# VAD tuning
ENERGY_THRESHOLD = int(os.environ.get("VAD_THRESHOLD", "300"))
SPEECH_START_FRAMES = 3          # ~90ms of speech to trigger start
SILENCE_END_FRAMES = 30          # ~900ms of silence to trigger end
MIN_UTTERANCE_FRAMES = 10        # ~300ms minimum to transcribe

# Services
WHISPER_URL = os.environ.get("WHISPER_URL", "http://localhost:2022/v1/audio/transcriptions")
_DATA_DIR = os.environ.get("CLAUDE_PLUGIN_DATA", os.environ.get("XDG_RUNTIME_DIR", "/tmp"))
TTS_PID_FILE = os.environ.get("TTS_PID_FILE", os.path.join(_DATA_DIR, "tts.pid"))

_PID_DIR = os.environ.get("XDG_RUNTIME_DIR", "/tmp")
LOCK_FILE = os.path.join(_PID_DIR, "claude-converse.lock")


LOG_FILE = os.environ.get("LISTENER_LOG", os.path.join(_DATA_DIR, "listener.log"))
_log_fh = None

def log(msg):
    global _log_fh
    if _log_fh is None:
        os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
        _log_fh = open(LOG_FILE, "a")
    _log_fh.write(msg + "\n")
    _log_fh.flush()


# ---------------------------------------------------------------------------
# Barge-in: kill TTS on speech start
# ---------------------------------------------------------------------------

def kill_tts():
    try:
        with open(TTS_PID_FILE) as f:
            pid = int(f.read().strip())
        os.killpg(os.getpgid(pid), signal.SIGTERM)
        log(f"[barge-in] killed TTS pid {pid}")
    except (FileNotFoundError, ValueError, ProcessLookupError, PermissionError):
        pass


# ---------------------------------------------------------------------------
# Whisper transcription
# ---------------------------------------------------------------------------

def transcribe(audio_bytes: bytes) -> str:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(audio_bytes)
    buf.seek(0)

    try:
        resp = requests.post(
            WHISPER_URL,
            files={"file": ("audio.wav", buf, "audio/wav")},
            data={"model": "base", "response_format": "json", "language": "en"},
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json().get("text", "").strip()
    except Exception as e:
        log(f"[whisper] transcription failed: {e}")
        return ""


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def run():
    # Acquire exclusive lock — only one voice session at a time
    lock_fh = open(LOCK_FILE, "w")
    try:
        fcntl.flock(lock_fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("Voice mode is already active in another session.", flush=True)
        sys.exit(1)
    # Write session ID so the status line can identify which session has voice mode
    session_id = os.environ.get("CLAUDE_SESSION_ID", "")
    lock_fh.write(session_id)
    lock_fh.flush()

    pa = pyaudio.PyAudio()

    try:
        info = pa.get_default_input_device_info()
        log(f"[listener] mic: {info['name']}")
    except IOError:
        log("[listener] ERROR: no input device")
        sys.exit(1)

    stream = pa.open(
        format=FORMAT,
        channels=CHANNELS,
        rate=SAMPLE_RATE,
        input=True,
        frames_per_buffer=FRAME_SIZE,
    )

    log(f"[listener] started (threshold={ENERGY_THRESHOLD})")

    speech_frames = []
    consecutive_speech = 0
    consecutive_silence = 0
    in_speech = False

    # Pre-buffer: keep last N frames so we capture audio before speech trigger
    from collections import deque
    PRE_BUFFER_FRAMES = 10  # ~300ms of audio before speech detected
    pre_buffer = deque(maxlen=PRE_BUFFER_FRAMES)

    try:
        while True:
            raw = stream.read(FRAME_SIZE, exception_on_overflow=False)
            samples = np.frombuffer(raw, dtype=np.int16)
            rms = np.sqrt(np.mean(samples.astype(np.float64) ** 2))

            is_speech = rms > ENERGY_THRESHOLD

            if not in_speech:
                pre_buffer.append(raw)
                if is_speech:
                    consecutive_speech += 1
                    if consecutive_speech >= SPEECH_START_FRAMES:
                        in_speech = True
                        consecutive_silence = 0
                        # Include pre-buffer so we don't clip the start of speech
                        speech_frames = list(pre_buffer)
                        pre_buffer.clear()
                        kill_tts()
                        log("[vad] speech start")
                else:
                    consecutive_speech = 0
            else:
                speech_frames.append(raw)

                if is_speech:
                    consecutive_silence = 0
                else:
                    consecutive_silence += 1

                if consecutive_silence >= SILENCE_END_FRAMES:
                    in_speech = False
                    consecutive_speech = 0
                    consecutive_silence = 0

                    if len(speech_frames) >= MIN_UTTERANCE_FRAMES:
                        audio_data = b"".join(speech_frames)
                        speech_frames.clear()
                        # Transcribe in background thread so mic keeps recording
                        threading.Thread(
                            target=_transcribe_and_emit,
                            args=(audio_data,),
                            daemon=True,
                        ).start()
                    else:
                        log(f"[vad] utterance too short ({len(speech_frames)} frames), discarding")
                        speech_frames.clear()

    except KeyboardInterrupt:
        pass
    finally:
        stream.stop_stream()
        stream.close()
        pa.terminate()
        log("[listener] stopped")


def _transcribe_and_emit(audio_data: bytes):
    text = transcribe(audio_data)
    if text:
        # This is the key line: stdout goes to Monitor → Claude sees it
        print(text, flush=True)
        log(f"[transcription] {text}")


if __name__ == "__main__":
    run()
