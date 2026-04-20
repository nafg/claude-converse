# Converse

Non-blocking, interruptible voice interface for Claude Code.

## Plugin Structure

```
.claude-plugin/plugin.json      — Plugin manifest
skills/converse/SKILL.md        — /converse skill (toggle voice mode)
skills/converse/listener.py     — Mic → energy VAD → Whisper STT → stdout
hooks/hooks.json                — Hook registrations
hooks/speak.py                  — TTS via Kokoro + Stop hook
hooks/inject-session-id.py      — PreToolUse hook: injects authoritative
                                   session_id into the listener's env
```

## Services

- Kokoro TTS: `http://localhost:8880/v1/audio/speech` (OpenAI-compatible)
- Whisper STT: `http://localhost:2022/v1/audio/transcriptions` (whisper.cpp)

### Whisper setup requirement

whisper-server must be started with `--no-context`. Without it, the decoder's
`prompt_past` token buffer persists across HTTP requests, so a single bad
transcription contaminates every subsequent one until the server is restarted.

voicemode's default startup omits the flag. Add it to
`~/.voicemode/services/whisper/bin/start-whisper-server.sh`:

```
exec "$SERVER_BIN" \
    --host 0.0.0.0 \
    --port "$WHISPER_PORT" \
    --model "$MODEL_PATH" \
    --inference-path /v1/audio/transcriptions \
    --threads 8 \
    --no-context
```

Then `voicemode service restart whisper`. The flag only disables cross-request
context; within a single request, multi-window (30 s+) utterances still flow.

## How it works

1. `/converse` starts listener via Monitor (persistent)
2. User speaks → listener kills any TTS (barge-in) → transcribes → stdout → Monitor delivers to Claude
3. Claude responds → Stop hook fires (async) → speak.py reads JSON, extracts message, plays TTS
4. Loop back to 2

## Key details

- speak.py auto-detects JSON (hook mode) vs plain text (manual mode)
- In hook mode: kills existing TTS, runs async (configured in hooks.json)
- PID file and logs stored in $CLAUDE_PLUGIN_DATA (or $XDG_RUNTIME_DIR, or /tmp)
- All paths configurable via environment variables


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
