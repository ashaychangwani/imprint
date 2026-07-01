---
name: imprint-example-refresh-release
description: Refresh checked-in examples from generated Imprint site tools and cut an Imprint patch release. Use when the user asks to commit new generated tools to examples, replace stale example tool snapshots, update example docs/tests after generated tool repairs, or publish a patch release after example/runtime fixes.
---

# Example Refresh Release

Use this to move verified generated tools into `examples/` and publish a patch release.
This complements the repo's `release` skill; follow that skill for the final version,
tag, push, and npm verification steps.

## Before Editing

Rebase before committing, as required by `AGENTS.md`:

```bash
git status --short --branch
git fetch origin main
git rebase origin/main
```

Inspect the generated site directory and existing example conventions:

```bash
find ~/.imprint/<site> -maxdepth 2 -type f | sort
rg --files examples/<site>
find examples -maxdepth 3 \( -name backends.json -o -name integration.test.ts -o -name '*.test.ts' \) -print | sort
```

## Copy Rules

Copy only active tool artifacts. Exclude local state:

- `node_modules/`
- `sessions/`
- dotfiles such as `.audit-*`, `.cdp-jar.json`, `.teach-state.json`,
  `.classifications.json`, `.build-plan.json`, `.compile-*`, `.tool-plan.md`
- `bun.lock`
- generated live `integration.test.ts` unless the example already commits them
- stale partial tool directories that lack complete `index.ts`/`workflow.json`

For generated Google Flights, the active refreshed directories were:

```text
_shared
lookup_flight_locations
get_flight_location_details
get_flight_calendar_prices
search_flights
get_flight_booking_options
validate_flight_itinerary
```

Use mechanical copy commands for bulk generated artifacts, then use `apply_patch` for
manual docs or test edits.

## Documentation And Tests

Update any root or example README references to old tool counts, old tool names, stale
audit percentages, or obsolete producer-token contracts.

If `tsconfig.json` includes `examples/**/*`, expect checked-in generated tools to
typecheck. Update repo tests that assert example tool lists or generated parser behavior,
but keep behavioral coverage. For Google Flights, preserve guards that:

- bad/non-batchexecute provider responses throw instead of returning false zeroes;
- one-way encoding works for string and numeric trip-type variants;
- missing return date forces one-way despite round-trip defaults;
- airline filters are rendered as included carriers;
- calendar duplicate dates keep the lowest fare;
- CDP reuse tests use framed batchexecute fixtures and bootstrap HTML matching current captures.

## Verification

Run checks before committing and before pushing:

```bash
bun run lint
bun run typecheck
bun test
```

If lint only reports formatting, run the formatter on the specific file and rerun lint.
If tests fail because example contracts changed, update the test fixture to the current
generated payload shape rather than deleting the coverage.

## Commits And Release

Commit the example refresh separately from the version bump:

```bash
git add -A README.md examples/<site> test
git commit -m "feat(examples): refresh <site> tools"
```

For a patch release:

1. read the existing `release` skill;
2. bump only `package.json` from `x.y.z` to `x.y.(z+1)`;
3. preview changelog with `bunx git-cliff --config cliff.toml --unreleased --strip header`;
4. rebase from `origin/main` again before committing the release bump;
5. commit `chore(release): v<VERSION>`;
6. tag `v<VERSION>`;
7. push branch and tags;
8. watch `release.yml`;
9. verify `npm view imprint-mcp version`.

Report the exact commits, tag, release workflow result, npm version, and final git status.
