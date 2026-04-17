#!/usr/bin/env python3
"""
Render recent voice transcriptions for the status line.

Reads the JSONL recent file written by listener.py, filters entries by age,
joins them, and prints to stdout. Prints nothing when voice mode is inactive
(lock file not held) or when the recent file has nothing within the window.

Status-line scripts can delegate to this so the formatting logic lives with
the plugin:

    voice=$(python "$PLUGIN/skills/converse/render_status.py")
    [ -n "$voice" ] && echo "$voice"
"""

import argparse
import fcntl
import json
import os
import sys
import time


def _default_recent_file() -> str:
    pid_dir = os.environ.get("XDG_RUNTIME_DIR", "/tmp")
    return os.path.join(pid_dir, "claude-converse-recent.jsonl")


def _default_lock_file() -> str:
    pid_dir = os.environ.get("XDG_RUNTIME_DIR", "/tmp")
    return os.path.join(pid_dir, "claude-converse.lock")


def _voice_mode_active(lock_file: str) -> bool:
    """Lock is held exclusively by the listener. If we can acquire it
    non-blocking, no listener is running."""
    try:
        fh = open(lock_file, "a+")
    except OSError:
        return False
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return True
    else:
        fcntl.flock(fh, fcntl.LOCK_UN)
        return False
    finally:
        fh.close()


def _load_entries(recent_file: str) -> list:
    entries: list = []
    try:
        with open(recent_file) as f:
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
    return entries


def render(
    window_seconds: float,
    separator: str,
    prefix: str,
    recent_file: str,
    lock_file: str,
) -> str:
    if not _voice_mode_active(lock_file):
        return ""

    entries = _load_entries(recent_file)
    if not entries:
        return ""

    cutoff = time.time() - window_seconds
    fresh = [e for e in entries if e.get("ts", 0) >= cutoff]
    if not fresh:
        return ""

    fresh.sort(key=lambda e: e.get("ts", 0))
    texts = [e.get("text", "") for e in fresh if e.get("text")]
    if not texts:
        return ""
    return prefix + separator.join(texts)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--window-seconds",
        type=float,
        default=float(os.environ.get("CONVERSE_STATUS_WINDOW", "30")),
        help="Show transcriptions newer than this many seconds (default: 30)",
    )
    parser.add_argument(
        "--separator",
        default=os.environ.get("CONVERSE_STATUS_SEPARATOR", " | "),
        help="String to join transcriptions with",
    )
    parser.add_argument(
        "--prefix",
        default=os.environ.get("CONVERSE_STATUS_PREFIX", "🎤 "),
        help="Leading label (e.g. mic emoji)",
    )
    parser.add_argument("--recent-file", default=_default_recent_file())
    parser.add_argument("--lock-file", default=_default_lock_file())
    args = parser.parse_args()

    out = render(
        args.window_seconds,
        args.separator,
        args.prefix,
        args.recent_file,
        args.lock_file,
    )
    if out:
        sys.stdout.write(out + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
