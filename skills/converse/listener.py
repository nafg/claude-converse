#!/usr/bin/env python3
"""
Voice loop listener — runs via Monitor.

Continuously records from the microphone, detects speech boundaries using
energy-based VAD, kills TTS on speech start (barge-in), and prints
transcriptions to stdout for Monitor to deliver to Claude.

Two silence thresholds:
  - CHUNK_SILENCE_FRAMES  — shorter pause → transcribe for status line only
  - UTTERANCE_END_FRAMES  — longer pause → transcribe and emit to the AI

Barge-in uses a separate higher energy bar and longer confirmation window so
breath and background noise don't kill TTS.

stdout format: one line per final transcription (Monitor delivers each line as a notification).
stderr: logging (goes to Monitor's output file, not to Claude).
"""

import fcntl
import io
import json
import os
import signal
import sys
import threading
import time
import wave
from collections import deque

import numpy as np
import pyaudio
import requests

# ---------------------------------------------------------------------------
# Audio format
# ---------------------------------------------------------------------------

SAMPLE_RATE = 16000
CHANNELS = 1
FORMAT = pyaudio.paInt16
FRAME_DURATION_MS = 30
FRAME_SIZE = int(SAMPLE_RATE * FRAME_DURATION_MS / 1000)  # 480 samples


def _int_env(name: str, default: int) -> int:
    return int(os.environ.get(name, str(default)))


def _float_env(name: str, default: float) -> float:
    return float(os.environ.get(name, str(default)))


# ---------------------------------------------------------------------------
# VAD tuning (all env-configurable)
# ---------------------------------------------------------------------------

# RMS threshold for "is this frame speech?"
ENERGY_THRESHOLD = _int_env("VAD_THRESHOLD", 300)

# How many consecutive speech frames start an utterance (captures the audio).
SPEECH_START_FRAMES = _int_env("VAD_SPEECH_START_FRAMES", 3)  # ~90ms

# Silence thresholds (30ms per frame)
CHUNK_SILENCE_FRAMES = _int_env("VAD_CHUNK_SILENCE_FRAMES", 20)     # ~600ms → status line update
UTTERANCE_END_FRAMES = _int_env("VAD_UTTERANCE_END_FRAMES", 50)     # ~1500ms → emit to AI

# Minimum utterance length to bother transcribing (in frames, pre-buffer included)
MIN_UTTERANCE_FRAMES = _int_env("VAD_MIN_UTTERANCE_FRAMES", 10)     # ~300ms

# Barge-in: separate, stricter bar than utterance-start. Designed so breath
# and background noise don't kill TTS.
BARGE_IN_ENERGY_MULTIPLIER = _float_env("VAD_BARGE_IN_ENERGY_MULT", 2.0)
BARGE_IN_FRAMES = _int_env("VAD_BARGE_IN_FRAMES", 6)               # ~180ms

# Pre-buffer: frames kept before speech trigger so we don't clip the start.
PRE_BUFFER_FRAMES = _int_env("VAD_PRE_BUFFER_FRAMES", 10)          # ~300ms

# ---------------------------------------------------------------------------
# Services and state files
# ---------------------------------------------------------------------------

WHISPER_URL = os.environ.get("WHISPER_URL", "http://localhost:2022/v1/audio/transcriptions")
WHISPER_INITIAL_PROMPT = os.environ.get("WHISPER_INITIAL_PROMPT", "")
_DATA_DIR = os.environ.get("CLAUDE_PLUGIN_DATA", os.environ.get("XDG_RUNTIME_DIR", "/tmp"))
TTS_PID_FILE = os.environ.get("TTS_PID_FILE", os.path.join(_DATA_DIR, "tts.pid"))

_PID_DIR = os.environ.get("XDG_RUNTIME_DIR", "/tmp")
LOCK_FILE = os.path.join(_PID_DIR, "claude-converse.lock")
RECENT_FILE = os.path.join(_PID_DIR, "claude-converse-recent.jsonl")
# The render routine filters by age, so we just need a reasonable cap on rows.
RECENT_MAX_ENTRIES = _int_env("RECENT_MAX_ENTRIES", 50)

LOG_FILE = os.environ.get("LISTENER_LOG", os.path.join(_DATA_DIR, "listener.log"))
_log_fh = None


def log(msg: str) -> None:
    global _log_fh
    if _log_fh is None:
        os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
        _log_fh = open(LOG_FILE, "a")
    _log_fh.write(msg + "\n")
    _log_fh.flush()


# ---------------------------------------------------------------------------
# Barge-in: kill TTS (only once enough loud frames accumulate)
# ---------------------------------------------------------------------------

def kill_tts() -> None:
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

    data = {"model": "base", "response_format": "json", "language": "en"}
    if WHISPER_INITIAL_PROMPT:
        data["prompt"] = WHISPER_INITIAL_PROMPT

    try:
        resp = requests.post(
            WHISPER_URL,
            files={"file": ("audio.wav", buf, "audio/wav")},
            data=data,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json().get("text", "").strip()
    except Exception as e:
        log(f"[whisper] transcription failed: {e}")
        return ""


# ---------------------------------------------------------------------------
# Recent-transcription file (JSONL; render_status.py formats it)
# ---------------------------------------------------------------------------
#
# Each line: {"id": <int>, "final": <bool>, "ts": <float>, "text": <str>}
#
# Writes are serialized with fcntl so concurrent chunk + final threads don't
# corrupt the file. Merge rules:
#   - finals replace any prior entry with the same id
#   - non-finals are dropped if a final for that id already exists
#   - non-finals replace prior non-finals for the same id (keep latest text)
# Final result: at most one line per utterance id, preferring the final
# transcription. Length is capped at RECENT_MAX_ENTRIES; older lines fall off.

_recent_lock = threading.Lock()


def _append_recent(entry: dict) -> None:
    with _recent_lock:
        entries: list = []
        try:
            with open(RECENT_FILE) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entries.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
        except FileNotFoundError:
            pass

        eid = entry["id"]
        is_final = entry["final"]

        existing = next((e for e in entries if e.get("id") == eid), None)
        if existing is not None:
            if existing.get("final") and not is_final:
                return
            entries.remove(existing)

        entries.append(entry)
        entries = entries[-RECENT_MAX_ENTRIES:]

        tmp = RECENT_FILE + ".tmp"
        with open(tmp, "w") as f:
            for e in entries:
                f.write(json.dumps(e, ensure_ascii=False) + "\n")
        os.replace(tmp, RECENT_FILE)


def _emit(utterance_id: int, is_final: bool, audio_data: bytes) -> None:
    """Transcribe and publish. Finals go to stdout (AI) and recent file;
    non-finals go only to the recent file (status line)."""
    text = transcribe(audio_data)
    if not text:
        return
    _append_recent({"id": utterance_id, "final": is_final, "ts": time.time(), "text": text})
    if is_final:
        print(text, flush=True)
        log(f"[transcription.final id={utterance_id}] {text}")
    else:
        log(f"[transcription.chunk id={utterance_id}] {text}")


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def run() -> None:
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

    log(
        f"[listener] started threshold={ENERGY_THRESHOLD} "
        f"chunk_silence={CHUNK_SILENCE_FRAMES}f "
        f"utterance_end={UTTERANCE_END_FRAMES}f "
        f"barge_in={BARGE_IN_FRAMES}f@{BARGE_IN_ENERGY_MULTIPLIER}x"
    )

    speech_frames: list = []
    consecutive_speech = 0
    consecutive_silence = 0
    consecutive_loud = 0
    in_speech = False
    chunk_emitted = False  # non-final already sent for the current utterance at current silence boundary
    tts_killed = False     # barge-in fired for the current utterance
    utterance_id = 0

    pre_buffer: deque = deque(maxlen=PRE_BUFFER_FRAMES)

    barge_in_threshold = ENERGY_THRESHOLD * BARGE_IN_ENERGY_MULTIPLIER

    try:
        while True:
            raw = stream.read(FRAME_SIZE, exception_on_overflow=False)
            samples = np.frombuffer(raw, dtype=np.int16)
            rms = float(np.sqrt(np.mean(samples.astype(np.float64) ** 2)))

            is_speech = rms > ENERGY_THRESHOLD
            is_loud = rms > barge_in_threshold

            # Barge-in: independent of utterance-start — requires sustained loud audio.
            # Reset tts_killed when the loud streak ends so the next streak can fire
            # again (e.g. a cough before any utterance-start shouldn't permanently
            # block future barge-ins).
            if is_loud:
                consecutive_loud += 1
                if consecutive_loud >= BARGE_IN_FRAMES and not tts_killed:
                    kill_tts()
                    tts_killed = True
            else:
                if consecutive_loud > 0:
                    tts_killed = False
                consecutive_loud = 0

            if not in_speech:
                pre_buffer.append(raw)
                if is_speech:
                    consecutive_speech += 1
                    if consecutive_speech >= SPEECH_START_FRAMES:
                        in_speech = True
                        consecutive_silence = 0
                        chunk_emitted = False
                        utterance_id += 1
                        speech_frames = list(pre_buffer)
                        pre_buffer.clear()
                        log(f"[vad] speech start id={utterance_id}")
                else:
                    consecutive_speech = 0
            else:
                speech_frames.append(raw)

                if is_speech:
                    consecutive_silence = 0
                    chunk_emitted = False  # new speech invalidates any chunk we'd re-emit
                else:
                    consecutive_silence += 1

                # Mid-utterance chunk boundary → non-final transcription for the status line.
                if (
                    not chunk_emitted
                    and consecutive_silence == CHUNK_SILENCE_FRAMES
                    and len(speech_frames) >= MIN_UTTERANCE_FRAMES
                ):
                    chunk_emitted = True
                    snapshot = b"".join(speech_frames)
                    threading.Thread(
                        target=_emit,
                        args=(utterance_id, False, snapshot),
                        daemon=True,
                    ).start()

                # Utterance end → final transcription → stdout + status line.
                if consecutive_silence >= UTTERANCE_END_FRAMES:
                    in_speech = False
                    consecutive_speech = 0
                    consecutive_silence = 0
                    tts_killed = False

                    if len(speech_frames) >= MIN_UTTERANCE_FRAMES:
                        audio_data = b"".join(speech_frames)
                        threading.Thread(
                            target=_emit,
                            args=(utterance_id, True, audio_data),
                            daemon=True,
                        ).start()
                    else:
                        log(
                            f"[vad] utterance too short ({len(speech_frames)} frames), discarding"
                        )
                    speech_frames = []
                    chunk_emitted = False

    except KeyboardInterrupt:
        pass
    finally:
        stream.stop_stream()
        stream.close()
        pa.terminate()
        log("[listener] stopped")


if __name__ == "__main__":
    run()
