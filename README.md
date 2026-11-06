# Standing orders

[![CI](https://github.com/Timeraa/standing-orders/actions/workflows/ci.yml/badge.svg)](https://github.com/Timeraa/standing-orders/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An autopilot for Claude Code, in three parts:

1. **Keeps working.** Claude stops ending long jobs on questions you've already answered.
2. **Right effort.** Each prompt runs at the thinking effort it needs, or at a level you fix.
3. **Right model.** A new chat starts on the model its first prompt calls for, and helper subagents get the model and effort their task needs.

You write your rules once ("run the tests yourself before asking me", "commit and push finished work", "always ask before deploying"). When Claude finishes a turn on something like *"Want me to commit?"*, a small Haiku call reads the end of its message against your rules and decides:

| Verdict | Meaning | What happens |
|---|---|---|
| **continue** | Your rules already answer it | The answer is drafted in your prompt box (or sent, in auto mode) |
| **ask** | It's your call (taste, product, or an *always-ask* word like `deploy`) | Nothing is answered. "Needs you" shows above the prompt and you get a notification |
| **stop** | The work is done | You get a notification |

A clickable status line and a `/crew` pane show what it is doing. A first-run setup (`/orders setup`) turns each part on or off.

## Install

```
/plugin marketplace add Timeraa/standing-orders
/plugin install standing-orders@standing-orders
```

Restart Claude Code. Needs a Claude Code version with mod (plugin) support.

## Why you can trust it

- **Draft is the default.** Answers are typed into your prompt box, not sent. Enter sends; edit or clear to answer yourself. A wrong draft costs one look.
- **Auto is opt-in per session** (`/orders auto`), capped at `max-auto` answers in a row (default 8), and never sends past an always-ask word. Every session starts back in draft.
- **Always-ask is enforced in code, not only by the model.** If the reply or the question matches one of your always-ask words, it asks you, whatever Haiku said. It errs toward asking.
- **You always win.** Anything you type yourself is never answered over, and a turn you typed into is never judged.
- **When unsure, it asks.** The judge prompt defaults to "ask"; a failed or unparseable judgement does nothing.
- **Nothing runs on your machine.** The mod never executes shell commands. It reads and writes only its own files (below).
- **It shows its work.** `/crew` lists the last decisions: answered, drafted, asked you, stopped.

### What leaves your machine

Only through Claude Code's own model call, to Haiku, in your existing session:
- the last ~2,500 characters of Claude's final message, plus your orders file, for each question-like turn end;
- your message (first ~3,000 characters) plus the tail of Claude's previous message, to pick an effort level;
- your first message of a chat, to pick its model (only with auto model);
- the task text of each subagent, to pick its model and effort (only with auto subagents).

No other network access. Nothing is sent anywhere else.

## Use it

The line above the prompt has two buttons: the mode label (click to cycle draft → auto → paused) and **Crew**, which opens the pane. Everything else is in `/crew`, which closes with Esc, its **Close** button, or `/crew` again:

- mode, answers given and effort, with meters for context and rate limit and the prompt-cache countdown;
- buttons for Pause, Draft/Auto and Effort;
- **Needs you**: the pending question and things only you can check, each with a **Done** button;
- **Agents** as a tree (status icon plus word, model, elapsed time, tool count, last tool);
- **What the orders did**: the last 8 decisions;
- **Finished** agents (fade after ten minutes; failed ones stay).

Commands, few on purpose:

```
/orders              short status
/orders help         the whole mod in plain words
/orders init         have Claude write this repo's own orders
/orders auto|draft   send answers yourself, or leave them for your Enter
/orders on|off       resume or pause
/orders effort auto|off|low|medium|high|xhigh|max   auto, off, or a fixed level
/orders effort min|max <level>                       bound what auto may pick
/orders model auto|off   pick the model for a brand-new chat
/orders setup        the first-run wizard again
/crew                details and controls
```

## Your orders

First run writes `~/.claude/standing-orders.md` with sensible defaults. Edit it freely; Claude reads it at the start of each chat. A repo can add `.claude/standing-orders.md` (`/orders init` has Claude write it from the repo's own docs and scripts).

Settings live at the bottom of the file:

```
always-ask: production, deploy, release, force push, delete, secret, payment
max-auto: 8
effort: auto
effort-min: low
effort-max: xhigh
subagents: auto
model: auto
models: sonnet, opus
cache-ttl: 60
```

The repo's `always-ask` words add to yours; its other settings win.

## Effort

`effort:` takes `auto`, `off`, or a fixed level (`low`, `medium`, `high`, `xhigh`, `max`).

- **auto**: Haiku picks a level for each prompt you type, only on Opus 5.5 and Sonnet 5.5, and never changes the model mid-chat, so the prompt cache survives. `effort-min` and `effort-max` bound what it may pick (default `low` to `xhigh`). `max` is never picked unless you set `effort-max: max`. A short "yes, go ahead" keeps the last level; past 85% of a usage limit it caps at medium.
- **a level**: every prompt runs at it, with no judge call and no Haiku cost.
- **off**: your own `/effort` stands. Setting `/effort` yourself also turns auto off.

The `/crew` Effort button cycles through all of these and writes the choice back to your orders file.

## Auto model

Off unless `model: auto` (the first-run setup offers it, pre-ticked). Only for a chat with no history: Haiku reads your first message and picks one of `models:` (default sonnet, opus). Every request of that chat then goes to that model, so nothing is rewritten in the prompt cache mid-chat. Run `/model` yourself and it steps aside. The chat's header may still show the model you started on.

## Subagents

With `subagents: auto`, each helper subagent gets a model and effort picked from its task before it starts: Haiku and low for searching and reading, a stronger model and effort for review and hard debugging. The pick is limited to `models:` plus Haiku and to your effort range. A model the Agent call already named is kept, and forks and teammates are skipped. Costs one small Haiku call per subagent.

## Develop

```
claude plugin marketplace add /path/to/standing-orders
claude plugin install standing-orders@standing-orders
claude plugin test .
claude plugin validate .
```

After edits: `claude plugin update standing-orders@standing-orders` and restart.

- `hooks/judges.ts`: pure parts (prompts, parsers, tree ordering). Tested directly.
- `hooks/register.tsx`: the mod itself (judge loop, commands, band, pane).
- `tests/`: runs with `claude plugin test`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

MIT, see [LICENSE](LICENSE).
