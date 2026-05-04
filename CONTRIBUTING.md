# Contributing to Imprint

Thanks for the interest. Imprint is a small project — issues, PRs, and bug reports are all welcome.

## Quick contributor setup

```bash
git clone https://github.com/<you>/imprint.git
cd imprint
bun install
bunx playwright install chromium
bun run check                     # typecheck + lint + 193 tests, ~12s combined
imprint doctor                    # verify env (after `bun link`)
```

If `bun run check` passes on `main` and `imprint doctor` is all green, your environment is good.

## Reporting bugs

Open an issue with:
1. **What you tried** — the exact `imprint <verb>` command + any flags.
2. **What you saw** — the output, stderr, and (if there's a stack trace) the `IMPRINT_DEBUG=1` rerun output.
3. **What you expected** — one sentence.
4. **The relevant config** — `cron.json` if cron-related, the workflow.json or playbook.yaml if compilation-related.

Don't paste credentials. Check `imprint redact <session>` if you're including a session.

## Proposing changes

Small tweaks (typo fixes, doc clarifications, narrow bug fixes): just open a PR.

Anything bigger:
1. **Open an issue first** describing the change. It's faster than rewriting code we'll have to push back on.
2. **Keep PRs focused.** One concern per PR. Refactors that touch many files should be in their own PR, separate from feature work.
3. **Tests pass before review.** `bun run check` (combined typecheck + lint + tests + knip dead-code scan) — all green.
4. **Live-verify when relevant.** If your change touches the cron path, the MCP server, or a backend, run a live tick against `examples/southwest` (or a similar real-world fixture). Note in the PR description.

## Repo conventions

- **Code style**: Biome handles both formatting and lints. Run `bun run lint:fix` to auto-format.
- **Comments**: sparse. Only when the WHY is non-obvious. The "why" usually goes in the commit message; the code explains the what. See [docs/decisions.md](docs/decisions.md) for the rationale behind this stance.
- **Tests**: behavior-level when possible. `test/sanity.test.ts` was deleted because it tested Zod, not Imprint — don't reintroduce that pattern.
- **Errors**: every user-reachable `throw new Error` should end with `→ next step:` when the fix is well-known. See [docs/troubleshooting.md](docs/troubleshooting.md) for the patterns we've already documented.
- **Dead code is blocked** — three layers, all part of `bun run check`:
  - `knip` for unused exports/files/types/deps
  - TypeScript's `noUnusedLocals` + `noUnusedParameters` for unused symbols inside a file
  - `madge --circular` for cycles between modules
  If any tool flags a new addition: drop the `export` (TS structural typing means callers don't need a named import to use your `*Options` / `*Result` interfaces), prefix unused params with `_`, or delete the artifact.
- **Commits**: imperative present tense; describe the WHY in the body for non-trivial changes.

## What's in scope vs. out of scope

**In scope:**
- New replay backends (e.g., a `playwright-cdp-pool` rung for high-throughput cases).
- New `notifyWhen` predicate types beyond `price_below`.
- New per-site auth extractors in `login.ts`.
- New CLI verbs that fit the `record → compile → run` lifecycle.
- Documentation, error messages, examples, and onboarding improvements.

**Out of scope** (for now):
- Hosted execution. The cron daemon runs on whatever box you put it on. v0.2 may add a Hetzner / Fly.io companion.
- A web UI / Chrome extension. CLI-first by design; a UI is a separate v0.2+ project.
- Workflows that mutate state without user-replay verification. Booking flows that auto-purchase need explicit user opt-in per call.

## Questions

Open an issue tagged `question` — answers go into [docs/troubleshooting.md](docs/troubleshooting.md) so the next person finds them.

## License

By submitting a PR, you agree to license your contribution under the same MIT license as the rest of the project. See [LICENSE](LICENSE).
