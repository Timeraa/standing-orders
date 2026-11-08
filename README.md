<img src=".claude-plugin/icon.png" width="96" align="right" alt="">

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

A clickable status line and the `/autopilot` pane show what it is doing and hold the settings: every part can be turned on or off there.

## Install

```
/plugin install standing-orders --marketplace Timeraa/standing-orders
```

From a shell: `claude plugin install standing-orders --marketplace Timeraa/standing-orders`. In the desktop app: + next to the prompt box, Plugins, Add marketplace `Timeraa/standing-orders`, then Add plugin.

Restart Claude Code. Tested on Claude Code 2.1.319. The mod API is early access, so a newer Claude Code can change it; CI runs the tests against the latest release.

## Why you can trust it

- **Draft is the default.** Answers are typed into your prompt box, not sent. Enter sends; edit or clear to answer yourself. A wrong draft costs one look.
- **Auto is opt-in per session** (`/orders auto`), capped at `max-auto` answers in a row (default 8), and never sends past an always-ask word. Every session starts back in draft.
- **Always-ask is enforced in code, not only by the model.** If the reply or the question matches one of your always-ask words, it asks you, whatever Haiku said. It errs toward asking.
- **You always win.** Anything you type yourself is never answered over, and a turn you typed into is never judged.
- **When unsure, it asks.** The judge prompt defaults to "ask"; a failed or unparseable judgement does nothing.
- **Nothing runs on your machine.** The mod never executes shell commands. It reads and writes only its own files (below).
- **It shows its work.** `/autopilot` lists the last decisions (answered, drafted, asked you, finished) and every pick it made (effort, a new chat's model, a subagent's model and effort), each with its reason.

### What leaves your machine

Only through Claude Code's own model call, to Haiku, in your existing session:
- the last ~2,500 characters of Claude's final message, plus your orders file, for each question-like turn end;
- your message (first ~3,000 characters) plus the tail of Claude's previous message, to pick an effort level;
- your first message of a chat, to pick its model (only with auto model);
- the task text of each subagent, to pick its model and effort (only with auto subagents).

No other network access. Nothing is sent anywhere else.

## Use it

The line above the prompt has two buttons: the mode label (`Replies: draft`, `Replies: auto` or `Replies paused`; click to cycle) and **Autopilot** (or **Autopilot · 3 to do** when checks wait), which opens the pane. Its other parts read `effort`, `context`, `usage limit` and `prompt cache` from 80 columns (`ctx`, `limit`, `cache` below that). The pane closes with Esc, its **Close** button, or `/autopilot` again, and has two tabs.

**Now**

- a short **What is this?** card while there is nothing to show yet (no answers, activity or waiting items); `/orders help` opens with the same text;
- mode, a sentence on what it does, answers given, and buttons for Draft/Auto and Pause;
- **Needs you**: the pending question, then things only you can check (a real device, an account, another person), each with a **Done** button and its age. It never holds what Claude could run or look up itself. Each judged turn replaces its own chat's earlier items, the judge ticks off ones the conversation shows are done, and items drop after 3 days. The pane shows the newest five with a **+N older** button. Items that share a lead ("After /reload-plugins, …") group under one heading with **Done all**; **↳ Ask** puts an item in your prompt box; an item in its last day says when it drops;
- **Activity**: the last 8 things the mod did, newest first. Decisions (`✓` sent, `✎` drafted, `?` asked you, `■` finished) and dimmed picks with their reason, for example `◆ effort high · multi-file feature`, `◇ new chat → opus · hard debugging`, `◇ subagent → haiku/low · grep the repo`. A line below counts this session's picks;
- **Usage**: context, usage limit and prompt-cache time left as bars, coloured by how full they are (one text line in a narrow pane), with a line saying what each name means.

Sections are bordered cards that light up under the pointer. Motion is calm: a spinner while the effort is being picked, bars that ease to a new value, and a short highlight on the newest entry. Nothing moves at rest, and it is plain text off the terminal.

**Settings** (every click saves to your orders file; each card says which lines of the file it writes)

- **Effort**: a button cycles auto, each level and off; with auto, buttons step the floor and ceiling or reset them;
- **New chats** and **Subagents**: turn auto model and auto subagents on or off; choose which models a new chat may pick from;
- **Replies**: how many answers auto mode sends in a row, and your always-ask words (click one to remove it, type to add);
- **Status line**: which parts the line above the prompt shows (mode, answered, effort, context, usage limit, prompt cache, repo-orders hint, the Autopilot button; the file's `band:` line spells them `ctx`, `limit`, `cache`) and how long your prompt cache lasts;
- **Motion**: turn the animations off;
- **Repo orders**: whether this repo has its own file, with a button to have Claude write it.

The pane body scrolls, so a long Needs you list never pushes the rest off.

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
/orders setup        open the Settings tab
/autopilot           the pane (/crew is its old name for now)
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
motion: on
band: mode, answered, effort, ctx, cache, hint, autopilot
```

A repo's file can come from any clone, so it may only tighten things: its `always-ask` words add to yours, its `max-auto` can only lower yours, and it may set `effort: off` and `cache-ttl`. Every other setting is read from your own file alone.

## Effort

`effort:` takes `auto`, `off`, or a fixed level (`low`, `medium`, `high`, `xhigh`, `max`).

- **auto**: Haiku picks a level for each prompt you type, only on Opus and Sonnet 5.5 or newer, and never changes the model mid-chat, so the prompt cache survives. `effort-min` and `effort-max` bound what it may pick (default `low` to `xhigh`). `max` is never picked unless you set `effort-max: max`. A short "yes, go ahead" keeps the last level; past 85% of a usage limit it caps at medium.
- **a level**: every prompt runs at it, with no judge call and no Haiku cost.
- **off**: your own `/effort` stands. Setting `/effort` yourself also turns auto off.

The Effort button on the `/autopilot` Settings tab cycles through all of these and writes the choice back to your orders file.

## Auto model

On in the file the first run writes (`model: auto`); the Settings tab turns it off. Only for a chat with no history: Haiku reads your first message and picks one of `models:` (default sonnet, opus), always the newest model of that family. Every request of that chat then goes to that model, so nothing is rewritten in the prompt cache mid-chat. Run `/model` yourself and it steps aside. The chat's header may still show the model you started on.

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

- `hooks/orders.ts`: the one home of the orders files (read, trust-merge, write, refresh, first-run seed).
- `hooks/picks.ts`: the effort, new-chat model and subagent judges, their deadline and bounds.
- `hooks/checks.ts`: the Needs you list (lifecycle, persistence, item identity).
- `hooks/run.ts`: the autopilot run and the order of the end-of-turn guards.
- `hooks/view.ts`: what the status line and the pane show, derived once for both.
- `hooks/judges.ts`: the remaining pure parts (prompts, parsers, log lines). Tested directly.
- `hooks/register.tsx`: the mod itself (hook wiring, commands, the drawing of the band and pane).
- `hooks/motion.tsx`: the surface module for the animated bits (spinner, bars, flash); pure drawing, no engine access.
- `tests/`: runs with `claude plugin test`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

MIT, see [LICENSE](LICENSE).
