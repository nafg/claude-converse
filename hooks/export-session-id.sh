#!/bin/sh
echo "export CLAUDE_SESSION_ID=$(jq -r .session_id)" >> "$CLAUDE_ENV_FILE"
