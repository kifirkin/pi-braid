#!/bin/bash
# Poll docs/ for new .md files until researcher review appears
# Exit 0 with path when found
DOCS="${1:-$PWD/docs}"
INTERVAL="${2:-30}"
START=$(date +%s)
echo "[wait] Polling $DOCS every ${INTERVAL}s..."

while true; do
  for f in "$DOCS"/*.md; do
    [ -f "$f" ] || continue
    MTIME=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null)
    if [ "$MTIME" -gt "$START" ]; then
      echo "$(basename "$f")"
      echo "PATH:$f"
      exit 0
    fi
  done
  sleep "$INTERVAL"
done
