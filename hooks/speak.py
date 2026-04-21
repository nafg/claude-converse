#!/usr/bin/env python3
"""
Speak text via chunked Kokoro TTS.

Can be used as a Claude Code stop hook (reads JSON from stdin, extracts
last_assistant_message) or directly with plain text (argument or stdin).

Detects JSON automatically — if stdin parses as JSON, extracts the message;
otherwise treats the input as plain text.

As a stop hook, only activates when the listener is running (voice mode on),
forks to background so the hook returns immediately, and kills any existing
TTS before starting (barge-in).

Stores PID in tts.pid so the listener can kill it on barge-in.

Usage:
    # As stop hook (stdin is JSON from Claude Code):
    hooks/hooks.json → command: "python3 ${CLAUDE_PLUGIN_ROOT}/hooks/speak.py"

    # Manual testing:
    python3 speak.py "Short text to speak"
    echo "Some **markdown** text" | python3 speak.py
"""

import fcntl
import hashlib
import io
import json
import os
import re
import signal
import sys
import time
import wave

import pyaudio
import requests

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

KOKORO_URL = os.environ.get("KOKORO_URL", "http://localhost:8880/v1/audio/speech")
KOKORO_VOICE = os.environ.get("KOKORO_VOICE", "af_heart")
KOKORO_MODEL = os.environ.get("KOKORO_MODEL", "kokoro")

_DATA_DIR = os.environ.get("CLAUDE_PLUGIN_DATA", os.environ.get("XDG_RUNTIME_DIR", "/tmp"))
_LOG_FILE = os.path.join(_DATA_DIR, "speak.log")


def _log(msg: str):
    with open(_LOG_FILE, "a") as f:
        f.write(f"{time.time():.3f} pid={os.getpid()} {msg}\n")
# PID file must use a stable shared path (not CLAUDE_PLUGIN_DATA, which hooks
# have but the listener doesn't), so barge-in can find the TTS process.
_PID_DIR = os.environ.get("XDG_RUNTIME_DIR", "/tmp")
TTS_PID_FILE = os.environ.get("TTS_PID_FILE", os.path.join(_PID_DIR, "tts.pid"))
TTS_LAST_FILE = os.path.join(_DATA_DIR, "tts_last.txt")
LOCK_FILE = os.path.join(_PID_DIR, "claude-converse.lock")

# Pause between chunks (seconds)
SENTENCE_PAUSE = 0.25
PARAGRAPH_PAUSE = 0.45


# ---------------------------------------------------------------------------
# PID management (for barge-in)
# ---------------------------------------------------------------------------

def write_pid():
    os.makedirs(os.path.dirname(TTS_PID_FILE), exist_ok=True)
    with open(TTS_PID_FILE, "w") as f:
        f.write(str(os.getpid()))


def remove_pid():
    try:
        os.remove(TTS_PID_FILE)
    except FileNotFoundError:
        pass


def kill_existing_tts():
    """Kill any existing TTS process (from a previous utterance)."""
    try:
        with open(TTS_PID_FILE) as f:
            pid = int(f.read().strip())
        os.killpg(os.getpgid(pid), signal.SIGTERM)
    except (OSError, ValueError):
        pass


def is_voice_session(hook_session_id: str) -> bool:
    """Check if voice mode is active for this session."""
    try:
        with open(LOCK_FILE) as f:
            # Try non-blocking lock — if we get it, nobody holds it (voice off)
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(f, fcntl.LOCK_UN)
            return False
    except OSError:
        # Lock is held — voice mode is on. Check session ID.
        try:
            with open(LOCK_FILE) as f:
                lock_session_id = f.read().strip()
            return lock_session_id == hook_session_id
        except (FileNotFoundError, ValueError):
            return False
    except FileNotFoundError:
        return False


def mark_if_new(text: str) -> bool:
    """True if this text differs from the last thing we spoke (and updates
    the stored hash so the next call sees it as the last). False means
    caller should skip as a duplicate."""
    text_hash = hashlib.md5(text.encode()).hexdigest()
    try:
        with open(TTS_LAST_FILE) as f:
            if f.read().strip() == text_hash:
                return False
    except (FileNotFoundError, ValueError):
        pass
    os.makedirs(os.path.dirname(TTS_LAST_FILE), exist_ok=True)
    with open(TTS_LAST_FILE, "w") as f:
        f.write(text_hash)
    return True


# ---------------------------------------------------------------------------
# Markdown stripping
# ---------------------------------------------------------------------------

def strip_markdown(text: str) -> str:
    """Remove markdown formatting, keeping the readable text."""
    # Code blocks → brief note
    text = re.sub(r"```[\s\S]*?```", " (code omitted) ", text)
    # Inline code → just the text
    text = re.sub(r"`([^`]+)`", r"\1", text)
    # Bold/italic
    text = re.sub(r"\*{1,3}(.+?)\*{1,3}", r"\1", text)
    text = re.sub(r"_{1,3}(.+?)_{1,3}", r"\1", text)
    # Headers → just the text
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.MULTILINE)
    # Links → just the label
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    # Horizontal rules
    text = re.sub(r"^[-*_]{3,}\s*$", "", text, flags=re.MULTILINE)
    # HTML tags
    text = re.sub(r"<[^>]+>", "", text)
    # Bullet markers (but keep the text)
    text = re.sub(r"^\s*[-*+]\s+", "", text, flags=re.MULTILINE)
    # Numbered list markers
    text = re.sub(r"^\s*\d+\.\s+", "", text, flags=re.MULTILINE)
    return text.strip()


# ---------------------------------------------------------------------------
# Text → chunks
# ---------------------------------------------------------------------------

# Common abbreviations that shouldn't end a sentence
ABBREVS = re.compile(
    r"\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|approx|dept|est|govt"
    r"|e\.g|i\.e|a\.m|p\.m|U\.S|Inc|Ltd|Co|Corp|Gen|Gov|Sgt|Pvt"
    r"|Capt|Lt|Cmdr|Adm|Rev|Hon|Pres|Vol|No)\.$",
    re.IGNORECASE,
)


def split_into_chunks(text: str) -> list[dict]:
    """
    Split text into speech chunks with pause metadata.

    Returns list of {"text": str, "pause": float} dicts.
    """
    if not text:
        return []

    chunks = []

    # Split on paragraph boundaries first (before stripping markdown,
    # so we can detect list structure)
    paragraphs = re.split(r"\n\n+", text)

    for para_idx, para in enumerate(paragraphs):
        para = para.strip()
        if not para:
            continue

        # Check if this paragraph contains a list
        lines = para.split("\n")
        is_list = any(re.match(r"\s*[-*+]\s|^\s*\d+\.\s", ln) for ln in lines)

        if is_list:
            # Each line becomes its own chunk (after markdown stripping)
            for line in lines:
                clean = strip_markdown(line).strip()
                if clean:
                    chunks.append({"text": clean, "pause": SENTENCE_PAUSE})
        else:
            # Regular paragraph: join lines, split into sentences
            clean = strip_markdown(para)
            lines_clean = [ln.strip() for ln in clean.split("\n") if ln.strip()]
            full_text = " ".join(lines_clean)

            sentences = _split_sentences(full_text)
            for sent in sentences:
                sent = sent.strip()
                if sent:
                    chunks.append({"text": sent, "pause": SENTENCE_PAUSE})

        # Bigger pause between paragraphs
        if chunks and para_idx < len(paragraphs) - 1:
            chunks[-1]["pause"] = PARAGRAPH_PAUSE

    # No trailing pause on the last chunk
    if chunks:
        chunks[-1]["pause"] = 0

    return chunks


def _split_sentences(text: str) -> list[str]:
    """Split text into sentences, handling common abbreviations."""
    sentences = []
    current = []

    # Tokenize by spaces to check abbreviations
    words = text.split()

    for word in words:
        current.append(word)

        # Check if this word ends with sentence-ending punctuation
        if re.search(r"[.!?]$", word):
            # But not if it's a known abbreviation
            joined = " ".join(current)
            if ABBREVS.search(joined):
                continue  # Not a real sentence end

            # Check for single-letter abbreviation (like "U." in "U.S.")
            if re.match(r"^[A-Z]\.$", word):
                continue

            sentences.append(joined)
            current = []

    # Remaining text becomes its own chunk
    if current:
        sentences.append(" ".join(current))

    return sentences


# ---------------------------------------------------------------------------
# TTS synthesis + playback
# ---------------------------------------------------------------------------

def synthesize(text: str) -> bytes:
    """Call Kokoro and return WAV bytes."""
    resp = requests.post(
        KOKORO_URL,
        json={
            "model": KOKORO_MODEL,
            "input": text,
            "voice": KOKORO_VOICE,
            "response_format": "wav",
        },
        timeout=30,
    )
    resp.raise_for_status()
    return resp.content


def get_default_output_device_index(pa: pyaudio.PyAudio) -> int | None:
    """Index of the default output device, or None if unavailable."""
    try:
        return int(pa.get_default_output_device_info()["index"])
    except (OSError, ValueError, KeyError, TypeError):
        return None


def play_wav(wav_bytes: bytes, pa: pyaudio.PyAudio, output_device_index: int | None = None):
    """Play WAV audio via pyaudio (blocking, no temp files)."""
    buf = io.BytesIO(wav_bytes)
    with wave.open(buf, "rb") as wf:
        stream = pa.open(
            format=pa.get_format_from_width(wf.getsampwidth()),
            channels=wf.getnchannels(),
            rate=wf.getframerate(),
            output=True,
            output_device_index=output_device_index,
        )
        chunk_size = 1024
        data = wf.readframes(chunk_size)
        while data:
            stream.write(data)
            data = wf.readframes(chunk_size)
        stream.stop_stream()
        stream.close()


# ---------------------------------------------------------------------------
# Core speak function
# ---------------------------------------------------------------------------

def speak(text: str):
    """Render text to speech chunks and play them."""
    # Own process group so barge-in can kill the whole tree
    try:
        os.setpgrp()
    except OSError:
        pass

    write_pid()

    try:
        chunks = split_into_chunks(text)
        pa = pyaudio.PyAudio()
        try:
            output_device_index = get_default_output_device_index(pa)

            for chunk in chunks:
                wav = synthesize(chunk["text"])
                play_wav(wav, pa, output_device_index=output_device_index)
                if chunk["pause"] > 0:
                    time.sleep(chunk["pause"])
        finally:
            pa.terminate()

    except (KeyboardInterrupt, SystemExit):
        pass
    except requests.RequestException as e:
        print(f"TTS error: {e}", file=sys.stderr)
    except OSError as e:
        print(f"Audio playback error: {e}", file=sys.stderr)
    finally:
        remove_pid()


# ---------------------------------------------------------------------------
# Input handling
# ---------------------------------------------------------------------------

def strip_echo_prefix(text: str) -> str:
    """Strip the transcription echo (everything before ---) so we only speak the response."""
    if "\n---\n" in text:
        return text.split("\n---\n", 1)[1]
    # Also handle --- at the very start of a line
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if line.strip() == "---":
            return "\n".join(lines[i + 1:])
    return text


def extract_text(raw: str, payload: dict | None) -> str | None:
    """Speakable text from stdin. Hook mode (payload is a dict) pulls
    last_assistant_message; otherwise raw is treated as plain text."""
    source = payload.get("last_assistant_message", "") if payload else raw
    if not source or not source.strip():
        return None
    return strip_echo_prefix(source).strip() or None


def _parse_hook_payload(raw: str) -> dict | None:
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None
    return data if isinstance(data, dict) else None


def main():
    # If arguments given, speak them directly (manual testing)
    if len(sys.argv) > 1:
        speak(" ".join(sys.argv[1:]))
        return

    raw = sys.stdin.read()
    if not raw.strip():
        return

    payload = _parse_hook_payload(raw)
    text = extract_text(raw, payload)
    if not text:
        return

    if payload is not None:
        if not is_voice_session(payload.get("session_id", "")):
            return
        if not mark_if_new(text):
            _log("skipping duplicate")
            return
        _log(f"speaking: {text[:80]!r}")
        kill_existing_tts()

    speak(text)


if __name__ == "__main__":
    main()
