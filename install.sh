#!/usr/bin/env bash
# install.sh — Install all prerequisites for simpleStem. Idempotent: safe
# to re-run; skips anything already installed.
#
# What this installs:
#   - ffmpeg, yt-dlp, pipx       (Homebrew)
#   - demucs                     (pipx isolated venv)
#   - torchcodec, librosa, soundfile  (injected into demucs's venv)
#   - PATH update so ~/.local/bin is on your zsh PATH

set -euo pipefail

say() { printf '>> %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

if ! have brew; then
  cat >&2 <<'EOF'
Homebrew is required but not installed.
Install it from https://brew.sh and re-run this script.
EOF
  exit 1
fi

# 1) Homebrew formulae
for pkg in ffmpeg yt-dlp pipx; do
  if brew list --formula "$pkg" >/dev/null 2>&1; then
    say "$pkg already installed (brew)"
  else
    say "Installing $pkg via brew…"
    brew install "$pkg"
  fi
done

# 2) pipx ensurepath + zshrc PATH
pipx ensurepath >/dev/null 2>&1 || true
ZSHRC="$HOME/.zshrc"
LINE='export PATH="$HOME/.local/bin:$PATH"'
if [[ -f "$ZSHRC" ]] && grep -Fq "$LINE" "$ZSHRC"; then
  say "PATH export already in $ZSHRC"
else
  say "Adding PATH export to $ZSHRC"
  echo "$LINE" >> "$ZSHRC"
fi
export PATH="$HOME/.local/bin:$PATH"

# 3) demucs via pipx
if pipx list --short 2>/dev/null | grep -q '^demucs '; then
  say "demucs already installed (pipx)"
else
  say "Installing demucs via pipx (pulls torch ~700 MB; takes a minute)…"
  pipx install demucs
fi

# 4) Inject torchcodec + librosa + soundfile into demucs venv
#    pipx inject is itself idempotent if the package is already present,
#    but it still re-resolves — call once per missing package.
DEMUCS_BIN="$(command -v demucs)"
while [[ -L "$DEMUCS_BIN" ]]; do
  target="$(readlink "$DEMUCS_BIN")"
  case "$target" in
    /*) DEMUCS_BIN="$target" ;;
    *)  DEMUCS_BIN="$(cd -- "$(dirname -- "$DEMUCS_BIN")" && pwd)/$target" ;;
  esac
done
VENV_PY="$(dirname "$DEMUCS_BIN")/python3"
[[ -x "$VENV_PY" ]] || VENV_PY="$(dirname "$DEMUCS_BIN")/python"

needed=()
for mod in torchcodec librosa soundfile; do
  if "$VENV_PY" -c "import $mod" 2>/dev/null; then
    say "$mod already present in demucs venv"
  else
    needed+=("$mod")
  fi
done
if (( ${#needed[@]} > 0 )); then
  say "Injecting into demucs venv: ${needed[*]}"
  pipx inject demucs "${needed[@]}"
fi

say "Verifying…"
have ffmpeg && have yt-dlp && have demucs
"$VENV_PY" -c 'import torchcodec, librosa, soundfile, numpy' >/dev/null

cat <<'EOF'

All prerequisites installed.

If "demucs" is not yet on your PATH in this shell, open a new terminal
(or run: exec zsh) so the PATH update takes effect.

Quick test:
  ./stem.sh "I Melt With You" "Modern English"

Sync the Mitchell Park song list from the shared Google Sheet:
  ./librarian.sh sheet         # full sync (writes metadata + GIGS/)
  ./librarian.sh sheet --dry-run
EOF
