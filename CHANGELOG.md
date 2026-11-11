# Changelog

## Unreleased
- **Pause for a session or a project**, without touching your orders file: `/orders pause [replies|effort|model|subagents] [project]` and `/orders resume …`, plus a Pause card on the Settings tab that does the same: everything at once, or one part per scope. Before, every off switch for effort, model and subagents rewrote `~/.claude/standing-orders.md`, so it turned them off in every session and project until turned back on. A session pause ends with the session (`/clear` starts a new one); a project pause is kept per folder in the plugin store, and every open session in that folder picks it up within seconds. `/orders on`, draft, auto and the mode click also end a project pause of replies. `/orders` lists what is paused, and paused parts say so on their Settings cards.
- A command typed as a chat's first prompt (`/autopilot`, `/orders pause model`) no longer uses up that chat's model pick; the first real prompt picks it. A `/model` typed first still steps it aside.
- The status line and the Now tab say `(paused)` for a paused effort instead of `(yours)`.
- `/orders subagents auto|off`: subagents had only a Settings button.
- Effort auto comes back when the orders turn it back on (an edited file, or a resume), unless you took effort over with `/effort`. Before, once off it stayed off until `/orders effort auto`.

## 0.13.0
- Savings can now prove it. The table reads Saved, Cost, Bottom line, with a verdict that says "Proven" only when its whole 95% range is on one side of zero.
- New **Savings audit** (`audit: on`, a button on the Savings tab; off by default): about one turn in five whose effort the mod would set runs at your own effort instead, chosen by a hash of the turn id. The difference in output tokens per request between the two groups is the effort effect, measured, with a 95% range. Without it effort stays an assumed estimate and the verdict says "Not proven".
- New measured cost: **cache rebuilds after effort changes**. Cache-write tokens of requests right after an effort change are compared with those after none, and any extra writes are subtracted in the net.

## 0.12.0
- Savings tab in the Autopilot pane (and `/orders savings`): is the autopilot paying for itself? Counts the real tokens of every request and of the mod's own Haiku calls, per day for 90 days, and shows today / 7 days / all time: what model picks saved (the same tokens repriced on the model your session would have used), what the picks and judging cost, the measured net and a one-sentence verdict. Dollars are API-equivalent list prices, so it works on a plan with no bill. The effort effect is shown apart as an estimate with its assumptions and range, and is not in the measured net.

## 0.11.0
- Plainer words: the Now tab opens with a "What is this?" card while it is empty (and `/orders help` starts with the same text), each Settings card says which line of `~/.claude/standing-orders.md` it saves to, the band reads `Replies: draft`, `effort`, `context`, `usage limit` and `prompt cache` (short forms below 80 columns), and the pane explains the mode, Effort, Needs you and the Usage names.
- The status line shows a waiting question on one line (`⚠ Needs you: first sentence… +2 more`) instead of wrapping the whole text; the Needs you card in the pane wraps the full question.
- Internal: orders, effort/model picks, Needs you checks and the status/pane display logic each live in one module (`hooks/orders.ts`, `picks.ts`, `checks.ts`, `view.ts`); tests share one fake engine.

## 0.10.0
- Calm motion on the terminal, only while something happens: a spinner with a shimmering label while the effort is picked (status line and Effort card), usage bars that ease to a new value, and a short highlight on the newest Needs you / Activity entry. Nothing animates at rest; desktop shows plain text. Settings → Motion turns it off (`motion: off`).
- The pane's sections are bordered cards that light up under the pointer (yellow when something needs you); the tab strip underlines the active tab; buttons light on hover. The footer line became Usage bars (a text line in a narrow pane).
- Needs you is more useful: items that share a lead ("After /reload-plugins, …") sit under one heading with **Done all**; each item has **↳ Ask**, which puts it in your prompt box; the last day before an item drops says "drops in 5h"; the waiting question says where to answer.
- The status line is responsive: it reads its width, shortens its words below 80 columns (`✎ draft`, `Sonnet·High`) and wraps whole parts instead of breaking them mid-label.
- Narrow panes read better: a Needs you item gets the full width with Done and Ask under it (one row from 80 columns), the Effort card puts the reason on its own line, and a bar's empty track is a thin line.
- Settings are grouped by priority: a missing repo orders file leads as its own card, then How it answers (replies, effort), Models, Display; a found repo file drops to the bottom.
- Settings: the model choices live inside the New chats card; usage bars show only the fill in colour, the empty track is dim.
- Settings now covers everything: which models a new chat may pick, answers in a row (`max-auto`), your always-ask words (remove or add), which parts the status line shows (`band:`, now with an optional `limit` part), and the prompt-cache window (`cache-ttl`).

## 0.9.2
- The Now tab has an Effort block: the level the mod picked for your prompt and why (or "set by you", or "capped by usage"). Settings no longer carry it.
- The band above the prompt and the Now tab show the model the chat runs on next to the effort (`Opus · High`), including a model the mod picked for a new chat.
- Settings rows no longer wrap ("Range") or run together ("Repo orders").

## 0.9.1
- Orders written while a session runs (Claude writing the repo file after "Write them", or an edit to either file) now reach the pane within 5 seconds, instead of only after your next prompt.

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
