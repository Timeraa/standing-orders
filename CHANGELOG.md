# Changelog

## 0.9.0
- `/crew` is now `/autopilot` (pane id `autopilot`, status-line button **Autopilot**). `/crew` still works as an alias for this release.
- Two tabs. **Now**: mode and the Auto/Pause buttons, Needs you, an Activity feed and one footer line (`ctx 41% · limit 20% · cache 51:40 left`). **Settings**: Effort (cycle, floor, ceiling, reset), New chats, Subagents and Repo orders, each saving to your orders file as you click.
- Activity shows what the mod picked and why, next to its decisions: the effort for a prompt, a new chat's model, a subagent's model and effort. The kept list grows from 20 to 30 entries; the pane shows 8.
- The first-run setup pane is gone: first run opens the Settings tab, and `/orders setup` does too. Nothing is saved by a Save button any more.
- The agent tree and Finished list are gone (Claude Code has its own tasks list); the three usage bars became the footer line; the status line no longer counts agents.
- The pane no longer budgets lines per section: it scrolls like any pane body, and Needs you always shows its newest five.
- The pane stops tracking tool calls, so a `tool.call` hook is no longer registered.

## 0.8.0
- Needs you no longer piles up. The judge now lists only what a person must do outside the chat (devices, accounts, other people), at most 5 per turn, never something Claude could run or look up, and never a merge, deploy or CI result.
- It sees the open items and ticks off the ones the conversation shows are done. A judged turn that finds new items replaces its chat's earlier ones, and repeats collapse.
- Items drop after 3 days and show their age. Your existing list is dated from the first load, so it expires three days after updating instead of being deleted.
- The pane shows the newest few (up to 5, fewer on a short pane) with a "+N older" button that expands the rest.

## 0.7.3
- Future models: the auto model pins a chat by alias (`opus`, `sonnet`), so it follows each family's newest model, and effort steering covers Opus and Sonnet 5.5 or newer instead of 5.5 alone.
- A finished subagent's picked effort and a forgotten agent's row are dropped, so long sessions stop accumulating them.
- Icon.

## 0.7.2
- The setup pane and the `/crew` Effort button start from your own file, so saving them never copies a repo's `effort: off` into it.
- A failed start logs its reason as text.

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
