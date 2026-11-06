# Changelog

## 0.7.1
- Fix: the setup pane showed "undefined" for floor and ceiling when an older saved value lacked them. Both now say "(default)" at the defaults, and a reset button restores them.
- Crew pane: new Autopilot panel with one row per part (replies, effort, new-chat model, subagents), each with its state and a button; Needs you moves up; usage meters get their own section; dividers between sections.
- Security: a repo's `.claude/standing-orders.md` can no longer loosen your settings. It may add always-ask words, lower `max-auto`, and set `effort: off` and `cache-ttl`; `max-auto` above yours, effort levels and range, `model`, `models` and `subagents` come only from your own file.
- `/orders` and `/crew` are registered first at start, so a failure while loading the orders file no longer leaves the mod without commands; that failure is logged.
- `/orders model` takes only `auto` or `off`; anything else shows the usage instead of turning auto model on.
- Setup pane says "Three helpers".
- CI installs Claude Code and runs `claude plugin validate` and `claude plugin test`.

## 0.7.0
- Effort: `effort:` takes `auto`, `off` or a fixed level (no judge); `effort-min` / `effort-max` bound auto; `max` is opt-in. `/orders effort <level>|min|max`, an Effort cycle button in `/crew`, floor and ceiling in the setup pane.
- Subagents: `subagents: auto` picks a model (Haiku allowed) and effort for each helper from its task; explicit choices win.
- "Needs you" notifications add a "So far" line.
- `/crew` shows per-session counts of efforts, models and steered subagents.

## 0.6.1
- Colour: heat-coloured meters and effort, coloured section headings and mode badges, a livelier setup pane.

## 0.6.0
- Auto model for new chats: the first prompt of a chat with no history picks Sonnet or Opus (`models:` setting); the chat then stays on it. `model: auto|off`, `/orders model auto|off`.
- First-run setup pane and `/orders setup` for auto effort and auto model.
- Renovate keeps GitHub Actions pinned and current.

## 0.5.1
- Crew pane: wrapping check and log rows, Done on the left, Clear all, counts, cleaner meters.

## 0.5.0
- Redesigned crew pane with meters, close and empty states; two-button status line.

## 0.4.0
- Crew pane with controls, order log, clickable status line.

Earlier versions: see `git log`.
