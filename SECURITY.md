# Security

Report vulnerabilities privately through [GitHub security advisories](https://github.com/Timeraa/standing-orders/security/advisories/new), not public issues. Expect a reply within a week.

The mod runs no shell commands and has no network access beyond Claude Code's own model call; see "What leaves your machine" in the README. A repo's `.claude/standing-orders.md` is treated as untrusted: it can add always-ask words, lower `max-auto`, set `effort: off` and `cache-ttl`, and nothing else. Its text still reaches Claude as instructions, the same way a repo's CLAUDE.md does, so read it in a repo you don't trust.

Reports about the always-ask guard being bypassed, or about a repo file loosening your settings, are especially welcome.
