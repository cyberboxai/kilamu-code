#!/usr/bin/env sh
# Fast gate for the opt-in tool-output compression hook. Bash runs often, so we
# avoid starting Node unless the project enabled context.compressToolOutput.
CFG="${KILAMU_DATA_DIR:-${CLAUDE_PROJECT_DIR:-.}/.kilamu}/config.json"
[ -f "$CFG" ] || exit 0
grep -Eq '"compressToolOutput"[[:space:]]*:[[:space:]]*true' "$CFG" 2>/dev/null || exit 0
exec "$(dirname "$0")/../bin/kilamu" hook post-tool-use
