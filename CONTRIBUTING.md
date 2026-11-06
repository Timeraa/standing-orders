# Contributing

Issues and PRs are welcome. Keep changes small and focused.

1. Fork, then `claude plugin marketplace add /path/to/your/clone`.
2. Make your change. Pure logic goes in `hooks/judges.ts` with a test in `tests/`; UI and commands in `hooks/register.tsx`.
3. Run `claude plugin test .` and `claude plugin validate .`.
4. Commit in [Conventional Commits](https://www.conventionalcommits.org/) style (`feat:`, `fix:`, `docs:`, `chore:`) and open a PR.

Safety rule: nothing may weaken the always-ask guard, "you always win", or the "when unsure, ask" default without a clear reason in the PR.
