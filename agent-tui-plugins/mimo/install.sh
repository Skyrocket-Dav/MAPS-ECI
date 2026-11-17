#!/usr/bin/env bash
# Install the pacman-tokens TUI plugin where MiMoCode scans for it:
# <config>/tui/*.{ts,tsx,js} is auto-discovered at TUI start, so no config
# entry and no package install are needed.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$here/pacman-tokens"
files=(pacman-tokens.tsx ecg.mjs)

if [ -n "${MIMOCODE_HOME:-}" ]; then
  config="$MIMOCODE_HOME/config"
else
  config="${XDG_CONFIG_HOME:-$HOME/.config}/mimocode"
fi
target="$config/tui"

mode="install"
force=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) mode="dry-run" ;;
    --force) force=1 ;;
    --uninstall) mode="uninstall" ;;
    -h|--help)
      echo "usage: $0 [--dry-run] [--force] [--uninstall]"
      echo "installs into: $target"
      exit 0
      ;;
    *)
      echo "unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

if [ "$mode" = "uninstall" ]; then
  for file in "${files[@]}"; do
    if [ -e "$target/$file" ]; then
      rm -f "$target/$file"
      echo "removed $target/$file"
    fi
  done
  exit 0
fi

for file in "${files[@]}"; do
  if [ ! -f "$src/$file" ]; then
    echo "missing source file: $src/$file" >&2
    exit 1
  fi
done

if [ -e "$target/pacman-tokens.tsx" ] && [ "$force" -ne 1 ] && [ "$mode" != "dry-run" ]; then
  echo "already installed at $target/pacman-tokens.tsx (use --force to replace)" >&2
  exit 1
fi

for file in "${files[@]}"; do
  echo "copy $src/$file -> $target/$file"
  if [ "$mode" = "dry-run" ]; then continue; fi
  mkdir -p "$target"
  cp "$src/$file" "$target/$file"
done

if [ "$mode" = "dry-run" ]; then
  echo "dry run: nothing changed"
  exit 0
fi

echo
echo "Installed. Restart the MiMoCode TUI to load it (a new session finds it at startup)."
echo "If it does not appear, start with: mimo --print-logs 2>&1 | grep '\\[tui.plugin\\]'"
