---
version: alpha
name: Imprint Landing System
description: Retro-terminal editorial system for the Imprint open-source CLI landing page
colors:
  background: "#0D1716"
  backgroundAlt: "#142421"
  surface: "#F2EBD8"
  surfaceRaised: "#FFF8E7"
  text: "#18211F"
  textOnDark: "#F2EBD8"
  muted: "#51615D"
  border: "#D8D0BA"
  accent: "#CFFF58"
  accentSecondary: "#FF7A45"
  accentSecondaryOnPaper: "#9A3418"
  accentTertiary: "#7BE7D8"
typography:
  display:
    fontFamily: Georgia
    fontSize: 72px
    fontWeight: 700
    lineHeight: 0.92
    letterSpacing: -0.055em
  body:
    fontFamily: Courier New
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.65
rounded:
  sm: 12px
  md: 18px
  lg: 30px
spacing:
  xs: 8px
  sm: 14px
  md: 24px
  lg: 40px
  xl: 72px
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#11180F"
    typography: "{typography.body}"
    rounded: 999px
    padding: 14px 18px
  terminal-card:
    backgroundColor: "#070D0C"
    textColor: "#DFF5E8"
    rounded: "{rounded.lg}"
    padding: 0px
  proof-card:
    backgroundColor: "{colors.surfaceRaised}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: 18px
---

## Overview

Imprint’s landing page uses a dark, instrument-panel atmosphere paired with warm paper proof sections. The tone should feel like a serious open-source tool for agent builders: technical, auditable, and direct, with enough editorial contrast to make the CLI memorable.

## Colors

Use deep green-black as the primary environment. Reserve acid green for primary actions, active status, and proof emphasis. Use ember orange for warnings, secondary highlights, and security/process labels on dark surfaces. On warm paper surfaces, darken ember to `#9A3418` for small labels so contrast stays accessible. Warm paper surfaces are used for comparison tables, examples, and artifact proof.

## Typography

Georgia carries the large, compressed editorial headlines. Courier New carries product copy, commands, navigation, tables, and CLI evidence. Keep body text left-aligned and generous in line-height; do not center long paragraphs.

## Layout

Primary content width is 1180px with 16px mobile gutters. Alternate dark technical sections with warm proof panels. Desktop favors asymmetric two-column sections; tablet and mobile collapse to one column. Terminal/code surfaces must allow horizontal overflow rather than clipping.

## Elevation & Depth

Prefer hard offset shadows and fine translucent borders over soft SaaS shadows. The terminal hero uses a chunky offset shadow; paper cards use subtle borders and occasional hard offsets.

## Shapes

Large panels use 30px radii, cards use 18–24px radii, and compact controls use pill radii. Nested shapes should stay smaller than their parent panel.

## Components

- Primary CTA: acid green pill, near-black text, hard green shadow.
- Secondary CTA: translucent dark pill with cream border.
- Terminal card: dark shell with traffic-light chrome, command transcript, and muted footer.
- Pipeline card: dark translucent surface with gradient top rule and artifact code chip.
- Comparison table: warm paper rows with acid-green win column and ember competitor column.

## Do's and Don'ts

Do make product proof concrete with file names, Bun-first commands, and replay timings. Do use real examples from the repository. Don’t introduce npm/npx command examples, generic SaaS illustrations, purple gradients, centered body copy, or fake testimonials.
