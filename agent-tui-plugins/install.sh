#!/usr/bin/env bash
# Deploy the TUI status-bar plugins from this bundle to a local client.
#
#   OpenCode  -> ${XDG_CONFIG_HOME:-~/.config}/opencode/plugins/pacman-tokens
#   Claude    -> ${CLAUDE_CONFIG_DIR:-~/.claude}/mods/pixel-tokens
#
# Existing installations are never overwritten unless --force is passed, and
# then the previous copy is moved aside with a timestamp instead of deleted.
set -euo pipefail

BUNDLE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"

DO_OPENCODE=1
DO_CLAUDE=1
ASSUME_YES=0
FORCE=0
DRY_RUN=0

OPENCODE_PLUGIN="$BUNDLE_DIR/opencode/pacman-tokens"
CLAUDE_PLUGIN="$BUNDLE_DIR/claude/pixel-tokens"
CLAUDE_ID="pixel-tokens@gnino-mods"
CLAUDE_MARKETPLACE="gnino-mods"

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Targets (default: both):
  --opencode          Install only the OpenCode plugin (pacman-tokens)
  --claude            Install only the Claude Code plugin (pixel-tokens)
  --all               Install both (default)

Behaviour:
  -y, --yes           Register/install/enable the Claude plugin without prompts
  --force             Replace an existing installation (the old copy is kept
                      next to it as <name>.bak.<timestamp>)
  --dry-run           Print the commands without changing anything
  -h, --help          Show this help

Environment:
  XDG_CONFIG_HOME     Overrides ~/.config for the OpenCode plugin location
  CLAUDE_CONFIG_DIR   Overrides ~/.claude for the Claude plugin location

Nothing in this bundle contains credentials. The OpenRouter API key used by
pacman-tokens is stored by OpenCode, not here; enter it on the target with
/balance. The Claude plugin reads usage from the running session and stores nothing.
EOF
}

while (($#)); do
  case "$1" in
    --opencode) DO_CLAUDE=0 ;;
    --claude) DO_OPENCODE=0 ;;
    --all) DO_OPENCODE=1; DO_CLAUDE=1 ;;
    -y | --yes) ASSUME_YES=1 ;;
    --force) FORCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

run() {
  if ((DRY_RUN)); then
    say "[dry-run] $*"
  else
    "$@"
  fi
}

# copy_plugin <source dir> <destination dir> <backup root>
# The backup lives outside the scanned plugins/mods directory: OpenCode treats every
# immediate child of opencode/plugins as a plugin, so a *.bak sibling would be loaded
# alongside the new copy (same id, two registrations — the stale one can win).
copy_plugin() {
  local src="$1"
  local dest="$2"
  local backup_root="$3"

  [[ -d "$src" ]] || die "missing bundle directory: $src"

  # Older installers left backups beside the plugin, where OpenCode discovers and
  # loads them as a second copy with the same id. Move any such leftovers out of
  # the scanned directory before installing.
  local legacy
  for legacy in "$(dirname "$dest")/$(basename "$dest").bak."*; do
    [[ -d "$legacy" ]] || continue
    say "moving a legacy in-place backup out of the scanned directory: $legacy"
    run mkdir -p "$backup_root"
    run mv "$legacy" "$backup_root/"
  done

  if [[ -e "$dest" ]]; then
    if ((FORCE)); then
      local backup="$backup_root/$(basename "$dest").bak.${STAMP}"
      say "existing copy found, moving it to $backup"
      run mkdir -p "$backup_root"
      run mv "$dest" "$backup"
    else
      say "already installed, left untouched: $dest"
      say "  (re-run with --force to replace it; the current copy is backed up first)"
      return 0
    fi
  fi

  run mkdir -p "$(dirname "$dest")"
  run cp -a "$src" "$dest"
  if ((DRY_RUN)); then
    say "would install: $dest"
  else
    say "installed: $dest"
  fi
}

install_opencode() {
  local config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
  local dest="$config_home/opencode/plugins/pacman-tokens"
  local backup_root="$config_home/opencode/plugin-backups"

  say ""
  say "== OpenCode =="
  copy_plugin "$OPENCODE_PLUGIN" "$dest" "$backup_root"

  if command -v opencode >/dev/null 2>&1; then
    if ((DRY_RUN)); then
      say "opencode found; version check skipped in dry-run"
    else
      local raw version major
      raw="$(opencode --version 2>/dev/null | head -1 || true)"
      version="${raw#opencode }"
      major="$(printf '%s' "$version" | sed -nE 's/^v?([0-9]+).*/\1/p')"
      say "detected OpenCode ${version:-unknown}"
      case "$major" in
        2) ;;
        "") warn "could not read the OpenCode version; this plugin needs the V2 TUI plugin API" ;;
        *) warn "OpenCode ${version} is not V2; the session.composer.top slot will probably not load" ;;
      esac
    fi
  else
    warn "opencode is not on PATH; install it there and verify on the target"
  fi

  say "activate: run /reload inside the OpenCode TUI (new TUIs pick it up at startup)"
  say "verify:   the ECG bar appears above the prompt; /balance sets the OpenRouter key"
}

# Fallback used when the Claude CLI is missing or the plugin commands fail.
patch_claude_settings() {
  local settings="$1"
  local dest="$2"

  if ! command -v python3 >/dev/null 2>&1; then
    warn "python3 not found; add these entries to $settings by hand:"
    say '  "extraKnownMarketplaces": { "gnino-mods": { "source": { "source": "directory", "path": "'"$dest"'" } } }'
    say '  "enabledPlugins": { "'"$CLAUDE_ID"'": true }'
    return 0
  fi

  if [[ -f "$settings" ]]; then
    run cp -a "$settings" "${settings}.bak.${STAMP}"
  fi

  SETTINGS="$settings" DEST="$dest" PLUGIN_ID="$CLAUDE_ID" python3 - <<'PY'
import json
import os
import pathlib

path = pathlib.Path(os.environ["SETTINGS"])
data = {}
if path.exists() and path.read_text().strip():
    data = json.loads(path.read_text())

marketplace = data.setdefault("extraKnownMarketplaces", {}).setdefault("gnino-mods", {})
marketplace["source"] = {"source": "directory", "path": os.environ["DEST"]}

enabled = data.setdefault("enabledPlugins", {})
enabled[os.environ["PLUGIN_ID"]] = True

path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(data, indent=2) + "\n")
PY

  say "wrote marketplace and enabledPlugins entries to $settings"
  say "if the status line does not appear, finish with: claude plugin install $CLAUDE_ID"
}

install_claude() {
  local claude_home="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  local dest="$claude_home/mods/pixel-tokens"
  local backup_root="$claude_home/mod-backups"
  local failed=0

  say ""
  say "== Claude Code =="
  copy_plugin "$CLAUDE_PLUGIN" "$dest" "$backup_root"

  if command -v claude >/dev/null 2>&1; then
    local version
    version="$(claude --version 2>/dev/null | head -1 || true)"
    say "detected Claude Code ${version:-unknown}"

    if ((ASSUME_YES)); then
      # '-y' also covers the non-interactive case (no TTY): a plugin with hooks
      # runs code on the host, so this is only done when the user asked for it.
      run claude plugin marketplace add "$dest" --json ||
        warn "marketplace add reported an error (it may already be registered)"

      if ! run claude plugin install "$CLAUDE_ID" -y --json; then
        failed=1
      fi

      # Installing also enables the plugin, so 'enable' usually answers
      # "already enabled". Treat that as success and decide from the listing.
      if ((DRY_RUN)); then
        say "[dry-run] claude plugin enable $CLAUDE_ID --json"
      else
        claude plugin enable "$CLAUDE_ID" --json >/dev/null 2>&1 || true
        if ! claude plugin list --json 2>/dev/null | grep -q "\"id\": *\"$CLAUDE_ID\""; then
          warn "plugin is not listed after install"
          failed=1
        fi
      fi
    else
      say "run these three commands to finish:"
      say "  claude plugin marketplace add \"$dest\""
      say "  claude plugin install $CLAUDE_ID -y"
      say "  claude plugin enable $CLAUDE_ID"
      return 0
    fi
  else
    warn "claude is not on PATH; falling back to settings.json"
    failed=1
  fi

  if ((failed)); then
    patch_claude_settings "$claude_home/settings.json" "$dest"
  fi

  say "activate: start a new Claude Code session (the plugin loads at startup)"
  say "verify:   claude plugin details $CLAUDE_ID"
}

if ((DO_OPENCODE)); then
  install_opencode
fi
if ((DO_CLAUDE)); then
  install_claude
fi

say ""
if ((DRY_RUN)); then
  say "dry run complete; nothing was changed"
else
  say "done. See README.md for verification and uninstall steps."
fi
