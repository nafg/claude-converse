#!/usr/bin/env python3
"""
Render recent voice transcriptions for the status line.

Reads the JSONL recent file written by listener.py, filters entries by age,
joins them, and prints to stdout. Prints nothing when voice mode is inactive
(lock file not held), when a different session owns voice mode, or when this
session owns voice mode but is silent.

Status-line scripts can delegate to this so the formatting logic lives with
the plugin. Pipe Claude Code's status-line JSON payload (which contains
session_id) directly into render_status.py:

    voice=$(printf '%s' "$INPUT_JSON" | render_status.py)
    [ -n "$voice" ] && echo "$voice"

Or pass the session id explicitly:

    render_status.py --session-id "$CLAUDE_SESSION_ID"

If render_status.py can't determine the current session id, it returns empty.
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


def _voice_owner_session_id(lock_file: str) -> str | None:
    """None if voice mode is inactive (nobody holds the listener lock).
    Otherwise the session_id written to the lock file by listener.py
    (empty string if unreadable). One open() covers both the liveness
    probe and the id read."""
    try:
        fh = open(lock_file)
    except OSError:
        return None
    try:
        try:
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            try:
                return fh.read().strip()
            except (OSError, ValueError):
                return ""
        else:
            fcntl.flock(fh, fcntl.LOCK_UN)
            return None
    finally:
        fh.close()


def _session_id_from_stdin() -> str:
    """Try to extract session_id from a JSON payload on stdin.
    Returns empty string if stdin is a tty, empty, or unparseable.
    Claude Code's statusline contract pipes a JSON payload that includes
    session_id; this lets render_status.py be invoked directly as the
    statusline command, or be fed the same payload by a wrapper."""
    if sys.stdin.isatty():
        return ""
    try:
        raw = sys.stdin.read()
    except (OSError, ValueError):
        return ""
    if not raw.strip():
        return ""
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return ""
    if isinstance(data, dict):
        return data.get("session_id", "") or ""
    return ""


def _current_session_id(arg_session_id: str | None) -> str:
    if arg_session_id:
        return arg_session_id
    sid = _session_id_from_stdin()
    if sid:
        return sid
    return os.environ.get("CLAUDE_SESSION_ID", "")


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
    current_session_id: str,
) -> str:
    owner = _voice_owner_session_id(lock_file)
    if owner is None:
        return ""
    if not current_session_id or owner != current_session_id:
        return ""

    # Voice mode is on for this session. From here we always emit at least
    # the prefix as a "mic active" indicator.
    indicator = prefix.rstrip()

    entries = _load_entries(recent_file)
    if not entries:
        return indicator

    cutoff = time.time() - window_seconds
    fresh = [e for e in entries if e.get("ts", 0) >= cutoff]
    if not fresh:
        return indicator

    fresh.sort(key=lambda e: e.get("ts", 0))
    texts = [e.get("text", "") for e in fresh if e.get("text")]
    if not texts:
        return indicator
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
    parser.add_argument(
        "--session-id",
        default=None,
        help="Current session id (overrides stdin JSON / env CLAUDE_SESSION_ID).",
    )
    args = parser.parse_args()

    current = _current_session_id(args.session_id)

    out = render(
        args.window_seconds,
        args.separator,
        args.prefix,
        args.recent_file,
        args.lock_file,
        current,
    )
    if out:
        sys.stdout.write(out + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
