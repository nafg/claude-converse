#!/usr/bin/env python3
"""Persistent JSONL bridge from Converse to the official moonshine-voice package."""

from __future__ import annotations

import argparse
from array import array
import base64
from contextlib import redirect_stdout
import json
import sys
from typing import Any


MODEL_ARCH_NAMES = {
    "tiny": "TINY",
    "base": "BASE",
    "tiny-streaming": "TINY_STREAMING",
    "base-streaming": "BASE_STREAMING",
    "small-streaming": "SMALL_STREAMING",
    "medium-streaming": "MEDIUM_STREAMING",
}


def send(payload: dict[str, Any]) -> None:
    sys.__stdout__.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.__stdout__.flush()


def decode_pcm(value: Any, channels: Any) -> list[float]:
    if not isinstance(value, str):
        raise ValueError("pcmS16Le must be a base64 string")
    if not isinstance(channels, int) or isinstance(channels, bool) or channels < 1:
        raise ValueError("channels must be a positive integer")
    try:
        raw = base64.b64decode(value, validate=True)
    except Exception as error:
        raise ValueError("pcmS16Le is not valid base64") from error
    if len(raw) % 2:
        raise ValueError("pcmS16Le must contain complete 16-bit samples")

    samples = array("h")
    samples.frombytes(raw)
    if sys.byteorder != "little":
        samples.byteswap()
    if len(samples) % channels:
        raise ValueError("PCM sample count is not divisible by channels")
    if channels == 1:
        return [sample / 32768.0 for sample in samples]

    mono: list[float] = []
    for offset in range(0, len(samples), channels):
        mono.append(sum(samples[offset : offset + channels]) / (32768.0 * channels))
    return mono


def transcript_text(transcript: Any) -> str:
    if transcript is None:
        return ""
    return " ".join(
        text
        for line in transcript.lines
        if (text := (line.text or "").strip())
    ).strip()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--language", required=True)
    parser.add_argument("--model", choices=MODEL_ARCH_NAMES, required=True)
    args = parser.parse_args()

    try:
        # Moonshine and its downloader may print informational output. Keep stdout
        # exclusively for the JSONL protocol and forward diagnostics to stderr.
        with redirect_stdout(sys.stderr):
            from moonshine_voice import ModelArch, Transcriber, get_model_for_language

            model_arch = getattr(ModelArch, MODEL_ARCH_NAMES[args.model])
            model_path, resolved_arch = get_model_for_language(args.language, model_arch)
            transcriber = Transcriber(model_path=model_path, model_arch=resolved_arch)
    except Exception as error:
        send({"type": "fatal", "error": str(error)})
        return 1

    send({"type": "ready"})
    try:
        for raw_line in sys.stdin:
            request_id: str | None = None
            try:
                request = json.loads(raw_line)
                request_id = request.get("id")
                if request.get("type") != "transcribe" or not isinstance(request_id, str):
                    raise ValueError("invalid transcribe request")
                sample_rate = request.get("sampleRate")
                if not isinstance(sample_rate, int) or isinstance(sample_rate, bool) or sample_rate <= 0:
                    raise ValueError("sampleRate must be a positive integer")
                audio = decode_pcm(request.get("pcmS16Le"), request.get("channels"))
                with redirect_stdout(sys.stderr):
                    transcript = transcriber.transcribe_without_streaming(audio, sample_rate)
                send({"type": "result", "id": request_id, "text": transcript_text(transcript)})
            except Exception as error:
                if request_id is None:
                    print(f"Moonshine protocol error: {error}", file=sys.stderr, flush=True)
                    continue
                send({"type": "result", "id": request_id, "error": str(error)})
    finally:
        transcriber.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
