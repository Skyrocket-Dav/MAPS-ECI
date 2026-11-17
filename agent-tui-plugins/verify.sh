#!/usr/bin/env bash
# Sanity-check this bundle before shipping it to another machine.
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

fail=0
ok() { printf '  ok    %s\n' "$*"; }
bad() {
  printf '  FAIL  %s\n' "$*"
  fail=1
}
note() { printf '  note  %s\n' "$*"; }

say() { printf '%s\n' "$*"; }

say "structure"
for file in \
  opencode/pacman-tokens/index.ts \
  opencode/pacman-tokens/tui.tsx \
  opencode/pacman-tokens/ecg.mjs \
  opencode/pacman-tokens/ecg.test.mjs \
  claude/pixel-tokens/.claude-plugin/plugin.json \
  claude/pixel-tokens/.claude-plugin/marketplace.json \
  claude/pixel-tokens/hooks/hooks.json \
  claude/pixel-tokens/hooks/register.ts \
  claude/pixel-tokens/types/index.d.ts \
  claude/pixel-tokens/tests/status.test.tsx \
  install.sh \
  versions.json; do
  if [[ -f "$file" ]]; then ok "$file"; else bad "missing $file"; fi
done

say ""
say "manifests"
if command -v python3 >/dev/null 2>&1; then
  python3 - <<'PY' || fail=1
import json
import pathlib
import sys

root = pathlib.Path(".")

def load(rel):
    return json.loads((root / rel).read_text())

problems = []
try:
    plugin = load("claude/pixel-tokens/.claude-plugin/plugin.json")
    market = load("claude/pixel-tokens/.claude-plugin/marketplace.json")
    hooks = load("claude/pixel-tokens/hooks/hooks.json")
    versions = load("versions.json")
except json.JSONDecodeError as exc:
    problems.append(f"invalid JSON: {exc}")
    plugin = market = hooks = versions = {}

if plugin and plugin.get("name") != "pixel-tokens":
    problems.append(f"plugin.json name is {plugin.get('name')!r}, install.sh expects 'pixel-tokens'")
if market and market.get("name") != "gnino-mods":
    problems.append(f"marketplace.json name is {market.get('name')!r}, install.sh expects 'gnino-mods'")
if market and not any(p.get("name") == "pixel-tokens" for p in market.get("plugins", [])):
    problems.append("marketplace.json does not list a 'pixel-tokens' plugin")
for module in (hooks or {}).get("modules", []):
    target = root / "claude/pixel-tokens/hooks" / module
    if not target.exists():
        problems.append(f"hooks.json module does not exist: {module}")
if not (hooks or {}).get("modules"):
    problems.append("hooks.json declares no modules")

if versions:
    for rel in ("opencode/pacman-tokens", "claude/pixel-tokens"):
        if rel not in versions.get("plugins", {}):
            problems.append(f"versions.json does not describe {rel}")

for problem in problems:
    print(f"  FAIL  {problem}")
if problems:
    sys.exit(1)
print("  ok    plugin, marketplace, hooks and versions.json agree")
PY
else
  note "python3 not found; skipping manifest checks"
fi

say ""
say "opencode unit tests"
if command -v node >/dev/null 2>&1; then
  if output="$(node --test opencode/pacman-tokens/ecg.test.mjs 2>&1)"; then
    printf '%s\n' "$output" | grep -E '(^# |ℹ )(pass|fail)' | sed 's/^/  /' || true
    ok "ecg tests passed"
  else
    printf '%s\n' "$output" | tail -20
    bad "ecg tests failed"
  fi
else
  note "node not found; skipping ecg tests"
fi

say ""
say "claude plugin tests"
if command -v claude >/dev/null 2>&1; then
  if output="$(claude plugin test claude/pixel-tokens 2>&1)"; then
    printf '%s\n' "$output" | tail -4 | sed 's/^/  /'
    ok "pixel-tokens tests passed"
  else
    printf '%s\n' "$output" | tail -20 | sed 's/^/  /'
    bad "pixel-tokens tests failed"
  fi
else
  note "claude not found; run 'claude plugin test claude/pixel-tokens' on the target"
fi

say ""
say "checksums"
if command -v sha256sum >/dev/null 2>&1 && [[ -f SHA256SUMS ]]; then
  if sha256sum --quiet -c SHA256SUMS; then
    ok "SHA256SUMS matches every file"
  else
    bad "SHA256SUMS does not match the bundle (regenerate it after edits)"
  fi
else
  note "sha256sum or SHA256SUMS missing"
fi

say ""
say "drift against this machine's live installs"
compare() {
  local label="$1" live="$2" copy="$3"
  if [[ ! -d "$live" ]]; then
    note "$label not installed here; skipped"
    return 0
  fi
  local report
  if report="$(diff -rq --exclude='.claude-plugin/types' "$live" "$copy" 2>&1)"; then
    ok "$label matches the bundle"
  else
    note "$label differs from the bundle:"
    printf '%s\n' "$report" | sed 's/^/        /'
  fi
}
compare "opencode/pacman-tokens" "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/pacman-tokens" "opencode/pacman-tokens"
compare "claude/pixel-tokens" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/mods/pixel-tokens" "claude/pixel-tokens"

say ""
if ((fail)); then
  say "verify: FAILED"
  exit 1
fi
say "verify: OK"
