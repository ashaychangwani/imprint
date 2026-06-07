---
name: release
version: 1.0.0
description: Cut a new semver release — bumps package.json, generates changelog preview, commits, tags, and pushes.
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

This triggers the `release.yml` workflow which creates the GitHub Release with auto-generated changelog.

## Step 9 — Confirm

Tell the user: "Release `v<VERSION>` tagged and pushed. GitHub Actions will create the release at `https://github.com/ashaychangwani/imprint/releases`."
