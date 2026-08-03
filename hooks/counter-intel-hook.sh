#!/bin/sh
# Appends one Claude Code hook event to counter-intel's event log.
# Runs on every hook event, so it must stay cheap and must never fail the session.

LOG_DIR="${COUNTER_INTEL_HOME:-$HOME/.claude/counter-intel}"
LOG="$LOG_DIR/events.jsonl"

mkdir -p "$LOG_DIR" 2>/dev/null || exit 0
command -v jq >/dev/null 2>&1 || exit 0

# $PPID is the claude process that spawned this hook — the link the transcripts don't record.
TTY=$(ps -o tty= -p "$PPID" 2>/dev/null | tr -d ' ')

jq -c \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg pid "$PPID" \
  --arg tty "$TTY" \
  '{
     session_id: (.session_id // .conversation_id // ""),
     event: (.hook_event_name // ""),
     cwd: (.cwd // (.workspace_roots // [])[0] // ""),
     ts: $ts,
     pid: ($pid | tonumber? // 0),
     tty: $tty
   }' >> "$LOG" 2>/dev/null

# Keep the log bounded without needing the server to be running.
if [ -f "$LOG" ]; then
  SIZE=$(wc -c < "$LOG" 2>/dev/null | tr -d ' ')
  if [ -n "$SIZE" ] && [ "$SIZE" -gt 4000000 ]; then
    tail -n 2000 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG" 2>/dev/null
  fi
fi

exit 0
