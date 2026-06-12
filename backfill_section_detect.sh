#!/usr/bin/env bash
# backfill_section_detect.sh — Run section_detect.py on every existing
# song folder in STEMS/. Idempotent by default: skips songs whose
# metadata.json already has a sectionCandidates field.
#
# Usage:
#   ./backfill_section_detect.sh                  dry-run report
#   ./backfill_section_detect.sh --go             actually analyze
#   ./backfill_section_detect.sh --go --force     recompute even if present
#
# Runtime budget: ~3 sec/song on CPU (six librosa.load + diff passes).
# 176 songs ≈ 9 minutes. The python venv with librosa must be available;
# this script picks the same python the rest of the pipeline uses
# (demucs pipx venv preferred — librosa is injected there).

set -uo pipefail

ROOT="${SIMPLE_STEM_ROOT:-$HOME/ClaudeDrive/simpleStem}"
STEMS_DIR="$ROOT/STEMS"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PY_SCRIPT="$SCRIPT_DIR/section_detect.py"

GO=0
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --go)    GO=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

[[ -f "$PY_SCRIPT" ]] || { echo "ERROR: missing $PY_SCRIPT" >&2; exit 1; }
[[ -d "$STEMS_DIR" ]] || { echo "ERROR: STEMS_DIR not found: $STEMS_DIR" >&2; exit 1; }

PYTHON_BIN=""
for p in \
  "$HOME/.local/pipx/venvs/demucs/bin/python3" \
  "$HOME/.local/pipx/venvs/demucs/bin/python" \
  /opt/homebrew/bin/python3 \
  /usr/local/bin/python3 \
  python3
do
  if command -v "$p" >/dev/null 2>&1 && "$p" -c 'import librosa, numpy' 2>/dev/null; then
    PYTHON_BIN="$(command -v "$p")"
    break
  fi
done
if [[ -z "$PYTHON_BIN" ]]; then
  echo "ERROR: no Python with librosa+numpy found." >&2
  echo "Run: pipx inject demucs librosa" >&2
  exit 1
fi

has_candidates() {
  local mp="$1"
  "$PYTHON_BIN" -c \
    "import json,sys; d=json.load(open('$mp')); sys.exit(0 if d.get('sectionCandidates') else 1)" \
    2>/dev/null
}

total=0; need=0; skipped=0
declare -a TARGETS=()

shopt -s nullglob
for d in "$STEMS_DIR"/*/; do
  total=$((total + 1))
  metadata="${d}metadata.json"
  [[ -f "$metadata" ]] || { skipped=$((skipped + 1)); continue; }
  if (( !FORCE )) && has_candidates "$metadata"; then
    skipped=$((skipped + 1))
    continue
  fi
  TARGETS+=("$d")
  need=$((need + 1))
done

echo "STEMS_DIR: $STEMS_DIR"
echo "Total song folders: $total"
echo "Already have candidates: $skipped"
echo "Need section_detect:    $need"
echo "Python: $PYTHON_BIN"
echo

if (( !GO )); then
  echo "Dry run. Re-run with --go to analyze."
  exit 0
fi

count=0
for d in "${TARGETS[@]}"; do
  count=$((count + 1))
  echo "[$count/$need] $(basename "$d")"
  if (( FORCE )); then
    "$PYTHON_BIN" "$PY_SCRIPT" "$d" --force || echo "  WARN: failed for $(basename "$d")"
  else
    "$PYTHON_BIN" "$PY_SCRIPT" "$d" || echo "  WARN: failed for $(basename "$d")"
  fi
done

echo
echo "Done. Verify with:"
echo "  grep -lr sectionCandidates \"$STEMS_DIR\" | wc -l"
