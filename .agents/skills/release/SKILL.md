---
name: release
version: 1.0.0
description: Cut a new semver release — bumps package.json, previews changelog, commits, tags, pushes, and verifies npm publish.
triggers:
  - release
  - cut a release
  - bump version
  - new release
allowed-tools:
  - Bash
  - Read
  - Edit
---

# Release Skill

Cut a new release for Imprint. Follow these steps in order.

## Step 1 — Determine bump type

Run `git log $(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)..HEAD --oneline` to see commits since the last tag.

Decide the bump type:
- **major** — breaking changes (`feat!:` or `BREAKING CHANGE` in body)
- **minor** — new features (`feat:`)
- **patch** — everything else (`fix:`, `refactor:`, `perf:`, `docs:`, `chore:`, etc.)

If unsure, ask the user.

## Step 2 — Read current version

Read `package.json` and extract the current `version` field.

## Step 3 — Compute new version

Apply semver bump to the current version. For example: `0.1.0` + minor = `0.2.0`.

## Step 4 — Update package.json

Edit `package.json` to set the new version string. Do not change anything else.

## Step 5 — Preview changelog

Run `bunx git-cliff --config cliff.toml --unreleased --strip header` and show the output to the user. Ask if it looks correct.

## Step 6 — Commit

Stage and commit:
```
git add package.json
git commit -m "chore(release): v<VERSION>"
```

Use the exact version string. No `Co-Authored-By` trailer for release commits.

## Step 7 — Tag

```
git tag v<VERSION>
```

## Step 8 — Push

Ask the user for confirmation, then:
```
git push && git push --tags
```

This triggers the `release.yml` workflow, which creates the GitHub Release, publishes the npm package, and uploads binaries.

## Step 9 — Watch publish

Watch the release workflow:
```
gh run list --workflow release.yml --limit 1
gh run watch <RUN_ID> --exit-status
```

Then verify npm:
```
npm view imprint-mcp version
```

If GitHub Actions cannot publish and local npm auth is available, publish manually from the tagged commit:
```
npm whoami
npm publish --access public
```

## Step 10 — Confirm

Tell the user: "Release `v<VERSION>` tagged and pushed. GitHub Actions created the release at `https://github.com/ashaychangwani/imprint/releases`, and npm shows `imprint-mcp@<VERSION>`."
