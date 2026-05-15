---
name: clean
version: 1.0.0
description: Clear compiled teach state for a site while preserving raw session recordings.
triggers:
  - clean
  - clean site state
  - reset teach state
  - clear state
allowed-tools:
  - Bash
  - Read
---

# Clean Skill

Wipe compiled artifacts from `~/.imprint/<site>/` while keeping the raw session recordings in `sessions/`.

## Step 1 — Identify the target site

If the user provided a site name as an argument (e.g. `/clean avis`), use that.

Otherwise, list available sites:
```
ls -d ~/.imprint/*/ 2>/dev/null | xargs -n1 basename | grep -v node_modules
```

If only one site exists, use it. If multiple exist, ask the user which site to clean.

## Step 2 — Validate the site exists

Confirm `~/.imprint/<site>/` exists. If not, tell the user and stop.

## Step 3 — Show what will be deleted

List everything in `~/.imprint/<site>/` except `sessions/`:
```
ls -A ~/.imprint/<site>/ | grep -v '^sessions$'
```

Show this list to the user and ask for confirmation before proceeding. This is a destructive operation.

## Step 4 — Delete compiled state

Remove everything except `sessions/`:
```
cd ~/.imprint/<site> && for item in * .*; do
  case "$item" in .|..|sessions) continue;; esac
  rm -rf "$item"
done
```

## Step 5 — Report results

Show what remains:
```
ls -la ~/.imprint/<site>/
```

Confirm that `sessions/` is intact and all compiled artifacts have been removed.
