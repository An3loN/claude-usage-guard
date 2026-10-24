---
name: usage-guard
description: Status and control of the usage-guard hook that pauses or defers token-heavy Claude Code work when plan limits reach 90%. Use for /usage-guard, or when the user asks about plan limits, the pause, deferred prompts, or wants to turn the guard on/off, release a pause, change its thresholds or set up its status line.
argument-hint: "[status|on|off|release|queue|clear-queue|set <key> <value>|classify <text>|statusline-setup]"
---

# usage-guard

The plugin's hooks run `scripts/usage-guard.js`:

- **UserPromptSubmit** roughly rates each prompt light / medium / heavy. At 90%+ of any plan window a heavy prompt is held until that window resets (`prompt_mode: wait`) or rejected and saved to a queue (`prompt_mode: block`); light and medium prompts run. At 98% everything waits.
- **PreToolUse** pauses a running heavy task at 90% until the reset. A medium task becomes heavy after 8 tool calls, a light one after 25, any task that starts a subagent at once. If the reset is more than 5.5 h away (weekly window) the task is stopped instead.
- **PostToolUse** saves the result of `mcp__ccd_session_mgmt__get_usage` (Claude desktop app) as the usage data, and asks Claude to refresh it when it gets old (more often the closer usage is to the limit).
- **statusLine** (terminal CLI only, set up by hand, see below) saves `rate_limits` and shows `5ч N% · 7д N%`. Without it, a terminal session has no usage data and the guard never pauses.

Prompt markers: `!force` skips the guard for that prompt, `!heavy` / `!light` override the estimate.

## Running a command

The script is at `${CLAUDE_PLUGIN_ROOT}/scripts/usage-guard.js`. If that placeholder is not filled in above, the script's path is in `~/.claude/usage-guard/script-path` (written on every hook run). Run it with the user's arguments (default `status`) and show its output as is:

```bash
node "$(cat ~/.claude/usage-guard/script-path)" <command> [args]
```

Before `status` in the desktop app, call `mcp__ccd_session_mgmt__get_usage` once so the numbers are fresh (the hook saves them).

| Command | Effect |
|---|---|
| `status` | enabled state, thresholds, usage per window, queue size |
| `on` / `off` | enable / disable the guard (an active pause ends within 15 s) |
| `release` | end the current pause; that task is not paused again |
| `queue` / `clear-queue` | show / delete prompts deferred in `block` mode |
| `set <key> <value>` | `threshold_pct`, `hard_pct`, `warn_pct`, `prompt_mode` (`wait`/`block`), `max_wait_hours`, `reset_buffer_sec` |
| `classify <text>` | show how a prompt would be rated |

A pause runs inside a hook, so the session that is paused cannot run commands itself: `release` and `off` are meant for another session or a terminal. To rerun a queued prompt, show it with `queue` and let the user send it again.

## statusline-setup

Plugins cannot set the status line, so for the terminal CLI add it to `~/.claude/settings.json` with the user's approval. Read the file first and merge; if a `statusLine` already exists, ask before replacing it. Use the absolute path from `~/.claude/usage-guard/script-path`:

```json
"statusLine": { "type": "command", "command": "node \"<script path>\" statusline" }
```

The path changes when the plugin is updated (new version directory), so rerun this after an update. Not needed in the desktop app.

Data lives in `~/.claude/usage-guard/` (`config.json`, `usage.json`, `deferred.jsonl`, `guard.log`).
