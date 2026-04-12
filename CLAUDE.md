# Imprint

**"Postman for AI Agents"** — Show an AI agent how to use a website once, and it can do it autonomously forever.

## What is this?

Imprint is a Chrome extension that watches you browse a website, captures the underlying API calls (network requests) and your narration of what you're doing, then generates a reusable automation that an AI agent can execute on its own. Think "teach by demonstration" for AI agents.

## Stage

Pre-product. Idea validated through design doc, not yet validated with users.

## Key decisions made

- **Approach:** Teach + Replay (Approach B). User teaches by demonstrating, agent replays for verification, user approves before autonomous execution.
- **Graduation path:** Approach C (Teach + Expand) where the agent learns related workflows autonomously. Research-stage, not committed.
- **Go-to-market:** Internal tools first. Companies automating their own admin panels/dashboards. Zero legal/ToS risk.
- **Positioning:** "Postman for AI agents." Turn any internal tool into an MCP server in 5 minutes.
- **Target user:** AI engineering teams at companies building agent products. NOT consumers (yet).
- **Name:** Imprint

## Core thesis

Personal AI agents are emerging and they need a teaching mechanism. "Similar to how you would teach a human" — show them, narrate what you're doing, and they learn the workflow. Network-level capture (API calls) is more durable than vision-based automation (screenshots/CSS selectors).

## Key risks

1. **Platform risk:** Anthropic/OpenAI could ship native MCP learning as a built-in feature
2. **Lesson rot:** Automations break as websites change (auth, API versions, A/B tests)
3. **Auth handling:** httpOnly cookies, token expiry, CSRF — the hardest technical problem
4. **Distribution:** Getting discovered in Chrome Web Store

## Terminology

- **Lesson:** A captured teaching session processed into a replayable workflow
- **Automation:** The executable artifact generated from a lesson (MCP server, API wrapper, script)
- **Replay:** Agent executing a learned lesson while the user watches for verification

## Project structure

```
docs/
  design.md      — Full design doc (approved, from /office-hours)
  wireframe.html — UI sketch (Chrome extension + dashboard + replay view)
```

## The assignment (before writing any code)

Find 5 AI engineering teams. Ask: "If you could turn any internal tool into an MCP server in 5 minutes by showing an AI how to use it, would you pay $29/month?"

3+ yes = build it. 0-2 yes = revisit target user.

## Tech stack (planned, not committed)

- Chrome Extension (Manifest V3, webRequest API, sidePanel)
- TypeScript
- Anthropic Claude Sonnet API (session analysis)
- Playwright (replay execution, health checks)
- Web dashboard (framework TBD)
