# agent-tui-plugins

Portable bundle of the two terminal status-bar plugins used in this account, ready to
deploy on other OpenCode and Claude Code clients.

Both plugins draw a braille trace of real token traffic — how many tokens were counted
since the previous tick, auto-scaled against a decaying recent peak, so the line reads as
flat when idle and spikes during a burst — plus the context left. Each one is written
against its own host API, so they are **not** shared code: OpenCode uses a TUI plugin
with a composer slot, Claude Code uses a mod hook module that draws a status line.

| Plugin | Host | Shows |
|--------|------|-------|
| `opencode/pacman-tokens` | OpenCode V2 | folder, token-traffic trace, `CTX` bar/%, `5H`/`WK`/`MO` (OpenCode Go), `5H`/`7D` (ChatGPT, with the time each window reopens), `BALANCE` (OpenRouter/DeepSeek credits, or `FREE` for a free OpenRouter model), connection state (heart, blinking line and toast) |
| `claude/pixel-tokens` | Claude Code | folder, token-traffic trace, `CTX` bar/%, `5H` and `7D` rate-limit bars (with the time each window reopens), offline state |

## Layout

```
agent-tui-plugins/
├── install.sh                     # copies (and registers) both plugins
├── verify.sh                      # structure, manifests, unit tests, checksums, drift
├── versions.json                  # what was exported, from which host versions
├── SHA256SUMS                     # integrity of every shipped file
├── opencode/pacman-tokens/        # global plugin directory, no package.json
│   ├── index.ts                   # server part (no-op, registers the id)
│   ├── tui.tsx                    # composer-top bar + /balance command
│   ├── ecg.mjs                    # pure rendering helpers
│   └── ecg.test.mjs               # 39 node tests
└── claude/pixel-tokens/           # local directory marketplace "gnino-mods"
    ├── .claude-plugin/plugin.json
    ├── .claude-plugin/marketplace.json
    ├── hooks/hooks.json
    ├── hooks/register.ts          # all behaviour
    ├── types/index.d.ts
    ├── tests/status.test.tsx      # 12 tests
    └── tsconfig.json
```

## Requirements

- **OpenCode V2** (`v2.2.5` here). The plugin uses `@opencode/plugin/tui`, `Plugin.define`,
  the `session.composer.top` slot and `context.client.experimental.usage.limits`. A V1
  client will not load it.
- **Claude Code** with the mod/hook API (`2.1.318` here): `import { atom, read, update }
  from 'claude-code'`, `$.ui.status`, `session.measure`, `ui.render` on `AbovePrompt`.
  Older builds fail to load the hook module.
- `node` ≥ 20 for the OpenCode tests, `bash` and `python3` for the installer fallback.
- No npm install, no build step, no global packages.

## Install

```bash
tar xzf agent-tui-plugins.tgz -C ~            # or clone the folder
cd ~/agent-tui-plugins
./install.sh --dry-run                        # see what would change
./install.sh --all --yes                      # install both, non-interactively
```

Targets and options:

```bash
./install.sh --opencode                       # copy the OpenCode plugin only
./install.sh --claude                         # copy the Claude plugin, print the CLI steps
./install.sh --claude --yes                   # ...and register/install/enable it
./install.sh --force                          # replace existing copies (backed up first)
```

The installer never overwrites silently: an existing installation is left alone unless
`--force` is passed, and then it is moved to `<name>.bak.<timestamp>` under
`opencode/plugin-backups/` or `mod-backups/` — outside the directories the hosts scan,
so a stale copy is never loaded beside the new one.

### What the installer touches

| Target | Path |
|--------|------|
| OpenCode plugin | `${XDG_CONFIG_HOME:-~/.config}/opencode/plugins/pacman-tokens` |
| Claude plugin | `${CLAUDE_CONFIG_DIR:-~/.claude}/mods/pixel-tokens` |
| Claude settings | `$CLAUDE_CONFIG_DIR/settings.json` — only as a fallback when the CLI cannot register the marketplace |

OpenCode picks the plugin up by directory discovery; no `opencode.json` entry is needed.
Claude needs the directory registered as the `gnino-mods` marketplace plus
`"pixel-tokens@gnino-mods": true` in `enabledPlugins`; `claude plugin marketplace add` /
`install` / `enable` do exactly that, with absolute paths computed on the target.

### Activate

- OpenCode: run `/reload` in the TUI (a fresh TUI finds the plugin at startup).
- Claude Code: start a new session.

## Verify

```bash
./verify.sh
```

It checks the file layout, that `plugin.json` / `marketplace.json` / `hooks.json` /
`versions.json` agree with what `install.sh` expects, runs the 39 OpenCode tests, runs
`claude plugin test` for the 12 Claude tests, validates `SHA256SUMS`, and — when the
plugins are installed on this machine — reports drift between the bundle and the live
copies.

Manual checks on the target:

```bash
opencode api get /api/plugin        # look for local.pacman-tokens
claude plugin details pixel-tokens@gnino-mods
```

## Credentials

The bundle contains no secrets and no machine state.

- `pacman-tokens` reads the OpenRouter key from OpenCode's plugin storage, then the
  plugin option `openrouterKey`, then `OPENROUTER_API_KEY`. On a new machine either set
  the environment variable or run `/balance` once (`/saldo` still works as an alias).
  The key is never written to this folder.
- `pacman-tokens`' ChatGPT `5H`/`7D` bars run `opencode auth export openai` (the same
  executable hosting the plugin) to reach the OAuth credential OpenCode already stores,
  then call `https://chatgpt.com/backend-api/codex/usage` directly. That endpoint is not
  a documented OpenAI API — it was confirmed by hand against a real account, and the
  plugin only labels a window `5H`/`7D` when its reported length matches 5h/7 days,
  dropping the segment instead of mislabeling it if the backend ever changes shape.
  It also reads `reset_at` (falling back to `reset_after_seconds`) and prints when the
  window reopens next to its percentage — the local clock time (`(11:29)`) when it is
  less than a day away, a coarse countdown (`(6d9h)`) beyond that. Its bars use
  `█`/`░` instead of font-dependent parallelogram glyphs. Nothing is scheduled
  from it: the value is re-read with the rest of the usage data every 60 seconds.
  The access token is only ever held in memory for that one request.
- `pacman-tokens` decides it is online only when both the OpenCode server answers
  `server.info` and a credential-free `HEAD` to the host serving the selected model
  completes (OpenRouter, DeepSeek, OpenAI, Anthropic, OpenCode Go, …; a local runtime
  such as Ollama has no host to probe). Any HTTP answer counts — even 401/404 — so only
  a network error or the 5-second timeout marks the bar offline. Losing the connection
  turns the heart red/broken, flattens the trace, and raises a toast (plus a system
  notification and sound when the terminal is not focused).
- `pixel-tokens` reads usage from the running session and does `HEAD https://api.anthropic.com`
  for connectivity. The `5H` and `7D` bars only appear on subscription accounts. When the
  session reports `resetsAt` for a window (epoch seconds on current builds), the bar appends
  the local clock time it reopens as `(11:29)` or, beyond a day, a coarse countdown like
  `(6d9h)`. Plain ASCII on purpose: the line is drawn by the terminal, and glyphs such as an
  arrow or a parallelogram are missing from many monospace fonts. The bars themselves use
  `█`/`░`, which ship with virtually every monospace font. Other field spellings (`resetAt`,
  `reset_at`, `resetsInSeconds`, …) are accepted defensively; an absent timestamp simply
  leaves the bar as it was.

## Uninstall

```bash
# OpenCode
rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/pacman-tokens"   # then /reload

# Claude Code
claude plugin uninstall pixel-tokens@gnino-mods
claude plugin marketplace remove gnino-mods
rm -rf "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/mods/pixel-tokens"
```

## Notes on portability

- Keep the folder names and the `gnino-mods` / `pixel-tokens` identities, or update
  `.claude-plugin/*.json`, `enabledPlugins` and `install.sh` together.
- `claude/pixel-tokens/tsconfig.json` extends `./.claude-plugin/types/tsconfig.json`,
  which Claude Code generates during dev-mod work. That directory is generated, not
  shipped, so `tsc` type-checking needs the host to create it; runtime and
  `claude plugin test` are unaffected.
- A `directory` marketplace is read in place: `claude plugin update pixel-tokens@gnino-mods`
  reports "read from its folder", and edits to that folder take effect at the next
  session start or `/reload-plugins`. Older installs may also carry a copy under
  `plugins/cache/...`; for a `directory` source it is not the code that runs.
- For distribution to several machines, put this folder in a git repository and use
  `claude plugin marketplace add <owner>/<repo>` (GitHub source) instead of a `directory`
  source; only the enable step is then per-machine.
- OpenCode can also load the plugin from `cli.json` (`"plugins": ["./plugins/pacman-tokens"]`).
  That keeps it active against a remote server, but requires a TUI-only package — remove
  the no-op `index.ts` first, since a plugin with a server part is loaded from
  `opencode.json(c)`.

See `versions.json` for the exact host versions this bundle was exported from.
