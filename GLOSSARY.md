# Glossary

Words this repo uses for the domain. Architecture words (module, interface, seam, depth) follow the codebase-design vocabulary.

- **Standing orders**: the markdown rules in `~/.claude/standing-orders.md`, plus an untrusted per-repo `.claude/standing-orders.md` that can only tighten. A `Settings` block of `key: value` lines in the same file holds the config. Owned by the **Orders** module (`hooks/orders.ts`).
- **Autopilot**: the mod, and its pane (Now and Settings tabs).
- **Judge**: a small Haiku call through `$.model.complete`. Four exist: the end-of-turn verdict (continue, ask, stop), the effort pick, the new-chat model pick, and the subagent pick. The last three live in **Picks** (`hooks/picks.ts`).
- **Mode**: draft (the reply goes into the prompt box) or auto (it is sent), plus paused.
- **Run**: the answers since the person last typed (`autoCount`, `pending`, `last`). Its transitions and the end-of-turn guard order live in **Run** (`hooks/run.ts`).
- **Rail**: the plain-code guard built from the always-ask words. It makes the autopilot ask whatever the judge said.
- **Needs you**: what only the person can do: the pending question plus the **Checks**.
- **Check**: a dated, per-chat item in Needs you with a 3-day TTL. Owned by the **Checks** module (`hooks/checks.ts`).
- **Chat**: one load of the mod (a /clear or reload starts a new one).
- **Effort**: auto (the judge picks inside min/max), fixed, off ("yours"), or saving (capped at medium at 85% usage).
- **Band**: the status line above the prompt.
- **Pane**: the Autopilot pane.
- **Vitals**: the ticking numbers (context, limit, cache time left).
- **Activity**: the pane's feed of what the mod did; **tally** is the session's counts.
- **View**: the display description derived from state for the Band and the Pane (`hooks/view.ts`).
