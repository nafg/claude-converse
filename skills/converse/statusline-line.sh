#!/bin/bash
# Plugin-side statusline composer.
#
# Reads Claude Code's statusline JSON payload from stdin (which contains
# session_id), and prints the voice-mode line ready to display — or nothing
# if voice mode is inactive, owned by a different session, or this session
# is silent and the user prefers not to see the indicator.
#
# Statusline scripts can call this directly; everything plugin-internal
# (lock-file gate, render_status.py invocation, color/dim styling) lives
# behind it, so the user's statusline only has to find this script and pipe
# the session JSON to it.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RENDER_PY="$SCRIPT_DIR/render_status.py"

# Fast path: skip the ~70 ms Python startup when the lock isn't held.
PID_DIR="${XDG_RUNTIME_DIR:-/tmp}"
LOCK_FILE="$PID_DIR/claude-converse.lock"
if [ ! -e "$LOCK_FILE" ]; then
    exit 0
fi
if flock --nonblock "$LOCK_FILE" true 2>/dev/null; then
    # We got the lock → nobody else holds it → voice mode is off.
    exit 0
fi

# Voice mode is on for *some* session. Let render_status.py decide whether
# it's ours; it reads the session_id from the JSON payload on stdin (which
# we inherit unchanged from the caller).
line=$(python3 "$RENDER_PY" 2>/dev/null)
[ -n "$line" ] || exit 0

# Dim + yellow.
printf '\033[2;33m%s\033[0m\n' "$line"
