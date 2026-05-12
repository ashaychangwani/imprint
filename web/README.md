# Imprint Web

Bun-first Vite/React landing page for the Imprint open-source CLI.

This directory is intentionally a standalone package. Do not add `web/` to
the root package workspaces: `bun install` from the repo root must stay focused
on the main Imprint CLI/TUI package and must not install React/Vite dependencies.

For deployment, configure Vercel with `web` as the project root. `vercel.json`
keeps the install command, build command, framework, and output directory scoped
to this package.

Run locally from `web/` with Bun:

```bash
bun install
bun run dev
```

Build and preview with Bun:

```bash
bun run build
bun run preview
```

## Verification

Before changing the landing page, run `bun run build` from this folder and
visually review the page across mobile, tablet, and desktop widths. Do not run
or document root-level web dependency installs.

The visual system is documented in `DESIGN.md`; keep it in sync when making landing page changes.
