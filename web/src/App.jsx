import React from 'react';
import { Link } from 'react-router-dom';

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accentColor": "#CFFF58",
  "paperTint": "#F2EBD8",
  "heroTilt": 1,
  "terminalScale": 1
}/*EDITMODE-END*/;

const product = {
  repo: 'github.com/ashaychangwani/imprint',
  githubUrl: 'https://github.com/ashaychangwani/imprint',
  install: 'bun install -g imprint-mcp',
  teach: 'imprint teach southwest --url https://www.southwest.com',
  installMcp: 'imprint install southwest --platform claude-desktop',
  installExample: 'imprint install google-flights --source examples --platform claude-desktop',
  shareMcp: 'imprint install mysite --platform codex',
};

const pipeline = [
  {
    step: '01',
    title: 'Teach once',
    body: 'Open Chromium, drive a real workflow, and narrate the intent while Imprint captures requests, DOM moves, cookies, storage, and session shape.',
    artifact: '~/.imprint/<site>/sessions/*.json',
  },
  {
    step: '02',
    title: 'Compile state',
    body: 'Generate a state-aware API workflow plus a DOM playbook fallback in one tool directory. When a recording yields several tools, shared signing and parsing modules are built and verified once, then reused; each tool is planned before it is compiled so the generated code follows a vetted plan.',
    artifact: '~/.imprint/<site>/<toolName>/{workflow.json,playbook.yaml}',
  },
  {
    step: '03',
    title: 'Call forever',
    body: 'Emit a typed MCP tool and install or remove it wherever your agent runs: Claude Code, Codex CLI, Claude Desktop, OpenClaw, Hermes, or cron.',
    artifact: 'imprint install <site>',
  },
];

const comparisons = [
  ['Runtime control', 'Deterministic replay', 'LLM chooses every click'],
  ['Token cost', 'Zero at runtime', 'Scales with every page'],
  ['State handling', 'Named captures + per-run cookie jar', 'Rediscover hidden tokens live'],
  ['Bot defense', 'Gated fetch-bootstrap → cdp-replay → stealth-fetch', 'Automation fingerprint risk'],
  ['Failure mode', 'Backend ladder fallback', 'Retry the same brittle path'],
  ['Typical result', '200ms fetch, browser only when needed', '30s+ exploration loop'],
];

const examples = [
  { name: 'google-flights ★', use: '4-tool suite', detail: 'One-shot compiled from a single recording: batchexecute wire-format decode + search→booking token chain. Audited 92.6%, every tool live-verified.' },
  { name: 'google-hotels ★', use: '4-tool suite', detail: 'One-shot compiled from a single recording: autocomplete → search → reviews/booking producer-token chaining. Audited 91.7%.' },
  { name: 'southwest', use: 'Live fare watcher', detail: 'Akamai-resistant flight search with price-drop notifications.' },
  { name: 'discoverandgo', use: 'Authed booking', detail: 'Museum-pass flow using the per-site credential store and replay state.' },
];

function LogoMark() {
  return (
    <a className="brand" href="#top" aria-label="Imprint home">
      <span className="brand-mark" aria-hidden="true">
        <span className="mark-track" />
        <span className="mark-dot dot-a" />
        <span className="mark-dot dot-b" />
      </span>
      <span className="brand-word">Imprint</span>
    </a>
  );
}

function TerminalCard() {
  return (
    <div className="terminal-card" aria-label="Imprint command preview">
      <div className="terminal-chrome">
        <span />
        <span />
        <span />
        <strong>imprint</strong>
      </div>
      <img className="terminal-gif" src="/imprint-teach.gif" alt="A real `imprint teach google-flights` run — six recordings compiled into four live-verified MCP tools" loading="lazy" />
      <div className="terminal-footer">
        <span>MIT license · Bun ≥ 1.3 · Chrome required</span>
        <span>v0.1 shipped</span>
      </div>
    </div>
  );
}

function PipelineCard({ item }) {
  return (
    <article className="pipeline-card">
      <span className="step-number">{item.step}</span>
      <h3>{item.title}</h3>
      <p>{item.body}</p>
      <code>{item.artifact}</code>
    </article>
  );
}

export default function App() {
  return (
    <>
      <style>{`
        :root {
          --bg: #0d1716;
          --bg-2: #142421;
          --surface: var(--ocd-tweak-paper-tint, #f2ebd8);
          --surface-2: color-mix(in srgb, var(--surface) 86%, white);
          --ink: #18211f;
          --ink-soft: #51615d;
          --muted: #aebbb5;
          --line: rgba(242, 235, 216, 0.2);
          --line-dark: rgba(24, 33, 31, 0.16);
          --acid: var(--ocd-tweak-accent-color, #cfff58);
          --ember: #ff7a45;
          --ember-ink: #9a3418;
          --cyan: #7be7d8;
          --deep: #08100f;
          --radius-lg: 30px;
          --radius-md: 18px;
          --radius-sm: 12px;
          --shadow-hard: 12px 12px 0 rgba(8, 16, 15, 0.55);
          --max: 1180px;
          --hero-tilt: var(--ocd-tweak-hero-tilt, 1);
          --terminal-scale: var(--ocd-tweak-terminal-scale, 1);
        }

        * { box-sizing: border-box; }
        html { scroll-behavior: smooth; }
        body {
          margin: 0;
          min-width: 320px;
          background: var(--bg);
          color: var(--surface);
          font-family: "Courier New", "Lucida Console", monospace;
          overflow-x: clip;
        }
        body::before {
          content: "";
          position: fixed;
          inset: 0;
          pointer-events: none;
          opacity: 0.045;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160' viewBox='0 0 160 160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.7'/%3E%3C/svg%3E");
          mix-blend-mode: screen;
          z-index: 5;
        }
        a { color: inherit; text-decoration: none; }
        button, a { -webkit-tap-highlight-color: transparent; }
        a:focus-visible, button:focus-visible {
          outline: 3px solid var(--acid);
          outline-offset: 4px;
          border-radius: 10px;
        }
        .page {
          background:
            radial-gradient(circle at 76% 6%, rgba(123, 231, 216, .28), transparent 30rem),
            radial-gradient(circle at 12% 24%, rgba(255, 122, 69, .18), transparent 24rem),
            linear-gradient(145deg, var(--bg), var(--bg-2) 58%, #111b18);
        }
        .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
        .nav-wrap {
          position: sticky;
          top: 0;
          z-index: 10;
          backdrop-filter: blur(18px);
          background: rgba(13, 23, 22, .72);
          border-bottom: 1px solid var(--line);
        }
        .nav {
          width: min(var(--max), calc(100% - 32px));
          margin: 0 auto;
          min-height: 72px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 22px;
        }
        .brand { display: inline-flex; align-items: center; gap: 12px; min-height: 44px; font-weight: 700; letter-spacing: -.03em; }
        .brand-mark {
          width: 42px; height: 42px; border: 1px solid rgba(207, 255, 88, .75);
          border-radius: 13px; position: relative; background: #0a1211; box-shadow: 5px 5px 0 rgba(207,255,88,.18);
          overflow: hidden;
        }
        .mark-track { position: absolute; inset: 8px 11px; border-left: 2px solid var(--acid); border-right: 2px solid var(--cyan); transform: skewX(-12deg); }
        .mark-dot { position: absolute; width: 8px; height: 8px; border-radius: 999px; background: var(--ember); }
        .dot-a { top: 9px; left: 9px; }
        .dot-b { bottom: 9px; right: 10px; background: var(--acid); }
        .brand-word { font-family: Georgia, "Times New Roman", serif; font-size: 1.45rem; color: var(--surface-2); }
        .nav-links { display: flex; align-items: center; gap: 24px; color: rgba(242, 235, 216, .78); font-size: .86rem; }
        .nav-links a { display: inline-flex; align-items: center; min-height: 44px; transition: color .2s ease; }
        .nav-links a:hover { color: var(--acid); }
        .nav-cta { display: inline-flex; align-items: center; gap: 9px; padding: 11px 14px; border: 1px solid rgba(207,255,88,.5); border-radius: 999px; color: var(--acid); background: rgba(207,255,88,.06); }

        .section { width: min(var(--max), calc(100% - 32px)); margin: 0 auto; }
        #workflow, #comparison, #examples, #install { scroll-margin-top: 92px; }
        .hero { padding: clamp(4.5rem, 8vw, 8.5rem) 0 5rem; display: grid; grid-template-columns: minmax(0, .92fr) minmax(340px, 1.08fr); gap: clamp(2rem, 5vw, 5rem); align-items: center; }
        .eyebrow { display: inline-flex; align-items: center; gap: 10px; color: var(--acid); border: 1px solid rgba(207,255,88,.38); border-radius: 999px; padding: 8px 13px; background: rgba(207,255,88,.06); font-size: .78rem; }
        .pulse { width: 8px; height: 8px; border-radius: 999px; background: var(--acid); box-shadow: 0 0 0 6px rgba(207,255,88,.12); }
        h1, h2, h3 { font-family: Georgia, "Times New Roman", serif; margin: 0; font-weight: 700; letter-spacing: -.055em; }
        h1 { font-size: clamp(3.35rem, 8vw, 7.65rem); line-height: .88; margin-top: 24px; max-width: 11ch; }
        .hero .lead { color: rgba(242,235,216,.78); font-size: clamp(1.04rem, 2vw, 1.32rem); line-height: 1.72; margin: 28px 0 0; max-width: 64ch; }
        .hero-actions { display: flex; flex-wrap: wrap; gap: 13px; margin-top: 34px; align-items: center; }
        .btn { display: inline-flex; align-items: center; justify-content: center; gap: 10px; min-height: 48px; padding: 13px 18px; border-radius: 999px; border: 1px solid transparent; font-weight: 700; font-size: .91rem; transition: transform .2s ease, box-shadow .2s ease, background .2s ease; }
        .btn:hover { transform: translateY(-2px); }
        .btn-primary { background: var(--acid); color: #11180f; box-shadow: 7px 7px 0 rgba(207,255,88,.18); }
        .btn-primary:hover { box-shadow: 10px 10px 0 rgba(207,255,88,.2); }
        .btn-secondary { border-color: rgba(242,235,216,.26); color: var(--surface-2); background: rgba(242,235,216,.05); }
        .hero-meta { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 36px; max-width: 650px; }
        .meta-tile { padding: 14px 14px 13px; border: 1px solid var(--line); border-radius: 16px; background: rgba(242,235,216,.055); }
        .meta-tile strong { display: block; color: var(--surface-2); font-size: 1.08rem; }
        .meta-tile span { color: var(--muted); font-size: .74rem; line-height: 1.4; }

        .terminal-card { border: 1px solid rgba(242,235,216,.25); border-radius: var(--radius-lg); background: #070d0c; box-shadow: var(--shadow-hard); overflow: hidden; transform: rotate(calc(var(--hero-tilt) * 1deg)); position: relative; }
        .terminal-card::after { content: ""; position: absolute; inset: auto -24px -38px auto; width: 150px; height: 150px; border-radius: 50%; background: rgba(255,122,69,.18); filter: blur(4px); z-index: 0; }
        .terminal-chrome { min-height: 48px; display: flex; align-items: center; gap: 8px; padding: 0 18px; border-bottom: 1px solid rgba(242,235,216,.16); color: rgba(242,235,216,.6); }
        .terminal-chrome span { width: 10px; height: 10px; border-radius: 999px; background: var(--ember); }
        .terminal-chrome span:nth-child(2) { background: #ffc857; }
        .terminal-chrome span:nth-child(3) { background: var(--acid); }
        .terminal-chrome strong { margin-left: auto; font-size: .75rem; color: rgba(242,235,216,.62); font-weight: 400; }
        .terminal-chrome, pre, .terminal-gif, .terminal-footer { position: relative; z-index: 1; }
        pre { margin: 0; padding: clamp(1.05rem, 2.4vw, 1.55rem); overflow-x: auto; max-width: 100%; }
        .terminal-gif { display: block; width: 100%; height: auto; }
        code { font-family: "Courier New", "Lucida Console", monospace; }
        pre code { display: block; color: #dff5e8; font-size: clamp(calc(.73rem * var(--terminal-scale)), 1.1vw, calc(.92rem * var(--terminal-scale))); line-height: 1.66; white-space: pre-wrap; overflow-wrap: anywhere; }
        .terminal-footer { display: flex; justify-content: space-between; gap: 16px; padding: 15px 18px; border-top: 1px solid rgba(242,235,216,.12); color: rgba(242,235,216,.58); font-size: .72rem; position: relative; z-index: 1; }

        .problem-band { margin-top: 16px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); background: rgba(8,16,15,.42); }
        .problem-inner { width: min(var(--max), calc(100% - 32px)); margin: 0 auto; display: grid; grid-template-columns: .9fr 1.1fr; gap: 40px; padding: clamp(2.6rem, 6vw, 5rem) 0; align-items: center; }
        .kicker { color: var(--ember); text-transform: uppercase; letter-spacing: .18em; font-size: .72rem; font-weight: 700; }
        .problem-inner h2, .section-head h2 { font-size: clamp(2.15rem, 5vw, 4.25rem); line-height: .97; margin-top: 12px; }
        .problem-copy { color: rgba(242,235,216,.75); line-height: 1.75; font-size: 1.02rem; }
        .belief-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
        .belief { border: 1px solid var(--line); border-radius: var(--radius-md); padding: 18px; background: rgba(242,235,216,.055); }
        .belief b { display: block; color: var(--acid); margin-bottom: 8px; }
        .belief span { color: rgba(242,235,216,.67); font-size: .88rem; line-height: 1.55; }

        .workflow { padding: clamp(4rem, 7vw, 7rem) 0; }
        .section-head { display: grid; grid-template-columns: .85fr 1fr; gap: 30px; align-items: end; margin-bottom: 30px; }
        .section-head p { margin: 0; color: rgba(242,235,216,.72); line-height: 1.7; font-size: 1rem; }
        .pipeline { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
        .pipeline-card { min-height: 280px; padding: 24px; border: 1px solid var(--line); border-radius: var(--radius-lg); background: linear-gradient(180deg, rgba(242,235,216,.09), rgba(242,235,216,.035)); position: relative; overflow: hidden; }
        .pipeline-card::before { content: ""; position: absolute; inset: 0 0 auto 0; height: 4px; background: linear-gradient(90deg, var(--acid), var(--cyan), var(--ember)); opacity: .82; }
        .step-number { display: inline-flex; color: rgba(242,235,216,.45); font-weight: 700; margin-bottom: 40px; }
        .pipeline-card h3 { font-size: 1.6rem; line-height: 1.02; margin-bottom: 12px; }
        .pipeline-card p { color: rgba(242,235,216,.69); line-height: 1.62; margin: 0 0 20px; }
        .pipeline-card code { display: inline-flex; max-width: 100%; overflow-wrap: anywhere; padding: 9px 10px; border-radius: 10px; background: rgba(8,16,15,.58); color: var(--cyan); border: 1px solid rgba(123,231,216,.18); font-size: .78rem; }

        .proof-panel { width: min(var(--max), calc(100% - 32px)); margin: 0 auto clamp(4rem, 7vw, 7rem); border-radius: 34px; overflow: hidden; background: var(--surface); color: var(--ink); display: grid; grid-template-columns: .95fr 1.05fr; border: 1px solid rgba(255,255,255,.1); }
        .proof-copy { padding: clamp(2rem, 5vw, 4.25rem); }
        .proof-copy h2 { color: var(--ink); font-size: clamp(2.2rem, 5vw, 4.4rem); line-height: .94; }
        .proof-copy p { color: var(--ink-soft); line-height: 1.72; font-size: 1rem; }
        .proof-panel .kicker, .examples .kicker { color: var(--ember-ink); }
        .artifact-stack { padding: clamp(1.2rem, 3vw, 2rem); background: #172521; display: grid; gap: 14px; align-content: center; }
        .artifact { border-radius: 18px; background: #fff8e7; color: var(--ink); padding: 18px; border: 1px solid rgba(8,16,15,.16); box-shadow: 8px 8px 0 rgba(8,16,15,.25); }
        .artifact:nth-child(2) { margin-left: 26px; }
        .artifact:nth-child(3) { margin-left: 52px; }
        .artifact small { color: var(--ember-ink); font-weight: 700; text-transform: uppercase; letter-spacing: .12em; }
        .artifact h3 { margin-top: 10px; font-size: 1.35rem; color: var(--ink); }
        .artifact p { margin: 8px 0 0; color: var(--ink-soft); line-height: 1.5; font-size: .9rem; }

        .comparison { padding: 0 0 clamp(4rem, 7vw, 7rem); }
        .comparison-grid { display: grid; grid-template-columns: .8fr 1.2fr; gap: 18px; align-items: start; }
        .backend-card { border-radius: var(--radius-lg); border: 1px solid rgba(207,255,88,.25); background: rgba(207,255,88,.075); padding: 26px; position: sticky; top: 96px; }
        .backend-card h3 { font-size: 2.1rem; line-height: .98; margin-bottom: 16px; }
        .ladder { display: grid; gap: 9px; margin-top: 20px; }
        .ladder-row { display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: center; padding: 12px 13px; border-radius: 14px; background: rgba(8,16,15,.5); border: 1px solid var(--line); }
        .ladder-row b { color: var(--surface-2); }
        .ladder-row span { color: var(--acid); font-size: .78rem; }
        .table-card { width: 100%; border-collapse: separate; border-spacing: 0; background: rgba(242,235,216,.96); color: var(--ink); border-radius: var(--radius-lg); overflow: hidden; }
        .comparison-row > th, .comparison-row > td { padding: 18px; line-height: 1.45; text-align: left; vertical-align: top; border-bottom: 1px solid rgba(24,33,31,.13); }
        .comparison-row:last-child > th, .comparison-row:last-child > td { border-bottom: 0; }
        .comparison-row .label { width: 26%; color: var(--ink-soft); font-weight: 700; }
        .comparison-row .win { width: 37%; color: #10201b; background: rgba(207,255,88,.28); }
        .comparison-row .other { width: 37%; color: #6b4d44; background: rgba(255,122,69,.12); }

        .examples { padding: clamp(4rem, 7vw, 7rem) 0; background: #f2ebd8; color: var(--ink); }
        .examples .section-head h2 { color: var(--ink); }
        .examples .section-head p { color: var(--ink-soft); }
        .example-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
        .example-card { min-height: 230px; border: 1px solid var(--line-dark); border-radius: 24px; background: #fff8e7; padding: 20px; display: flex; flex-direction: column; justify-content: space-between; }
        .example-card h3 { color: var(--ink); font-size: 1.45rem; letter-spacing: -.04em; }
        .example-card p { color: var(--ink-soft); line-height: 1.55; }
        .tag { display: inline-flex; width: max-content; padding: 7px 9px; border-radius: 999px; background: #172521; color: var(--acid); font-size: .73rem; }
        .example-install { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 18px; }
        .example-install .command { background: #172521; border-color: rgba(24,33,31,.2); }
        .example-install .command code { color: #dff5e8; }
        .example-install .command b { color: var(--acid); }

        .security { padding: clamp(4rem, 7vw, 7rem) 0; }
        .security-grid { display: grid; grid-template-columns: .95fr 1.05fr; gap: 28px; align-items: center; }
        .security-card { border: 1px solid var(--line); border-radius: var(--radius-lg); padding: clamp(1.5rem, 3vw, 2.4rem); background: rgba(242,235,216,.06); }
        .security-card h2 { font-size: clamp(2.1rem, 5vw, 4rem); line-height: .96; }
        .security-card p { color: rgba(242,235,216,.72); line-height: 1.7; }
        .checks { display: grid; gap: 12px; }
        .check { display: grid; grid-template-columns: 30px 1fr; gap: 12px; padding: 17px; border-radius: 18px; background: rgba(242,235,216,.055); border: 1px solid var(--line); }
        .check i { width: 30px; height: 30px; border-radius: 50%; background: rgba(207,255,88,.13); color: var(--acid); display: grid; place-items: center; font-style: normal; font-weight: 700; }
        .check b { color: var(--surface-2); }
        .check span { display: block; margin-top: 4px; color: rgba(242,235,216,.66); line-height: 1.55; font-size: .88rem; }

        .install { padding-bottom: clamp(4rem, 7vw, 7rem); }
        .install-panel { border-radius: 36px; background: #07100f; border: 1px solid rgba(207,255,88,.24); padding: clamp(1.4rem, 4vw, 3rem); display: grid; grid-template-columns: .85fr 1.15fr; gap: 28px; box-shadow: 0 28px 90px rgba(0,0,0,.28); }
        .install-panel h2 { font-size: clamp(2rem, 4.5vw, 4.1rem); line-height: .96; }
        .install-panel p { color: rgba(242,235,216,.7); line-height: 1.7; }
        .command-list { display: grid; gap: 10px; }
        .command { display: grid; grid-template-columns: auto 1fr; gap: 12px; align-items: start; padding: 14px; border-radius: 16px; border: 1px solid rgba(242,235,216,.16); background: rgba(242,235,216,.05); overflow: hidden; }
        .command b { color: var(--ember); }
        .command code { color: #dff5e8; overflow-wrap: anywhere; line-height: 1.5; }

        footer { border-top: 1px solid var(--line); padding: 28px 0; color: rgba(242,235,216,.62); }
        .footer-inner { width: min(var(--max), calc(100% - 32px)); margin: 0 auto; display: flex; justify-content: space-between; gap: 18px; flex-wrap: wrap; font-size: .8rem; }
        .footer-links { display: flex; gap: 16px; flex-wrap: wrap; }
        .footer-links a { display: inline-flex; align-items: center; min-height: 44px; }

        @media (max-width: 980px) {
          .hero, .problem-inner, .section-head, .proof-panel, .comparison-grid, .security-grid, .install-panel { grid-template-columns: 1fr; }
          .terminal-card { transform: none; }
          .pipeline { grid-template-columns: 1fr; }
          .pipeline-card { min-height: auto; }
          .backend-card { position: static; }
          .example-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .artifact:nth-child(2), .artifact:nth-child(3) { margin-left: 0; }
        }
        @media (max-width: 700px) {
          .nav { min-height: auto; padding: 10px 0 8px; align-items: center; gap: 8px 12px; flex-wrap: wrap; }
          .brand { flex: 1 1 auto; }
          .nav-links { order: 3; width: 100%; gap: 4px; font-size: .72rem; }
          .nav-links a { flex: 1 1 0; justify-content: center; min-height: 44px; padding: 0 4px; border: 1px solid rgba(242,235,216,.12); border-radius: 999px; background: rgba(242,235,216,.045); white-space: nowrap; }
          #workflow, #comparison, #examples, #install { scroll-margin-top: 132px; }
          .hero { padding-top: 3.4rem; }
          h1 { max-width: 9ch; }
          .hero-meta, .belief-grid, .example-grid, .example-install { grid-template-columns: 1fr; }
          .terminal-footer, .footer-inner { flex-direction: column; }
          .table-card, .table-card tbody, .comparison-row { display: block; width: 100%; }
          .comparison-row > th, .comparison-row > td { display: block; width: 100%; padding: 14px 16px; }
          .comparison-row > .label, .comparison-row > .win, .comparison-row > .other { width: 100%; }
          .comparison-row > th { border-bottom: 0; }
          .comparison-row:last-child > th, .comparison-row:last-child > td { border-bottom: 1px solid rgba(24,33,31,.13); }
          .comparison-row:last-child > td:last-child { border-bottom: 0; }
          .proof-panel, .install-panel { border-radius: 26px; }
          .btn { width: 100%; }
        }
        @media (prefers-reduced-motion: no-preference) {
          .hero-copy, .terminal-card, .pipeline-card, .example-card { animation: rise .7s ease both; }
          .terminal-card { animation-delay: .08s; }
          .pipeline-card:nth-child(2), .example-card:nth-child(2) { animation-delay: .08s; }
          .pipeline-card:nth-child(3), .example-card:nth-child(3) { animation-delay: .14s; }
          @keyframes rise { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: translateY(0); } }
        }
      `}</style>
      <div className="page" id="top">
        <header className="nav-wrap">
          <nav className="nav" aria-label="Primary navigation">
            <LogoMark />
            <div className="nav-links" aria-label="Page sections">
              <a href="#workflow">Workflow</a>
              <a href="#comparison">Why it wins</a>
              <a href="#examples">Examples</a>
              <a href="#install">Install</a>
              <Link to="/docs">Docs</Link>
            </div>
            <a className="nav-cta" href={product.githubUrl} aria-label="Open Imprint on GitHub">GitHub ↗</a>
          </nav>
        </header>

        <main>
          <section className="section hero" aria-labelledby="hero-title">
            <div className="hero-copy">
              <span className="eyebrow"><span className="pulse" aria-hidden="true" /> Postman for AI agents · open source CLI</span>
              <h1 id="hero-title">Don’t do anything twice.</h1>
              <p className="lead">Teach Imprint one real browser session and it turns that recording into a deterministic MCP tool: a state-aware API workflow, a DOM playbook fallback, and an agent-callable TypeScript module.</p>
              <div className="hero-actions">
                <a className="btn btn-primary" href="#install">Start with Bun</a>
                <a className="btn btn-secondary" href={product.githubUrl}>View source on GitHub</a>
              </div>
              <div className="hero-meta" aria-label="Project highlights">
                <div className="meta-tile"><strong>v0.1</strong><span>Shipped with working browser automation demos</span></div>
                <div className="meta-tile"><strong>5 modes</strong><span>fetch, fetch-bootstrap, cdp-replay, stealth-fetch, and playbook</span></div>
                <div className="meta-tile"><strong>Traceable</strong><span>Per-turn, per-tool, per-LLM-call Phoenix spans</span></div>
              </div>
            </div>
            <TerminalCard />
          </section>

          <section className="problem-band" aria-labelledby="problem-title">
            <div className="problem-inner">
              <div>
                <span className="kicker">The runtime problem</span>
                <h2 id="problem-title">LLMs should not relearn the same website on every run.</h2>
              </div>
              <div>
                <p className="problem-copy">Browser-use and Computer Use are powerful, but they spend runtime tokens deciding clicks, scanning pages, and recovering from variance. Imprint moves that intelligence to compile time: record a known-good path once, then replay it with deterministic machinery.</p>
                <div className="belief-grid">
                  <div className="belief"><b>Recordings are source</b><span>The human-demonstrated session becomes the executable contract.</span></div>
                  <div className="belief"><b>Fallback is built in</b><span>API replay, browser bootstrap, cdp-replay, stealth-fetch, and DOM playbooks form a backend ladder.</span></div>
                </div>
              </div>
            </div>
          </section>

          <section className="section workflow" id="workflow" aria-labelledby="workflow-title">
            <div className="section-head">
              <div>
                <span className="kicker">One command pipeline</span>
                <h2 id="workflow-title">From browser session to callable tool.</h2>
              </div>
              <p><code>bun run imprint teach</code> runs the complete path interactively: record, redact, generate, compile, emit, and wire the MCP server into the AI platform you choose. <code>imprint install</code> adds the same emitted server to another platform later, using absolute CLI paths for desktop config clients; <code>imprint uninstall</code> removes it.</p>
            </div>
            <div className="pipeline">
              {pipeline.map((item) => <PipelineCard key={item.step} item={item} />)}
            </div>
          </section>

          <section className="proof-panel" aria-labelledby="proof-title">
            <div className="proof-copy">
              <span className="kicker">Product proof</span>
              <h2 id="proof-title">Two replays are better than one brittle script.</h2>
              <p>Every taught workflow compiles into both a network-level workflow and a DOM-level playbook under the generated tool directory. When HTTP can mint cookies or CSRF state, Imprint stays on fetch. When Chromium is needed only to initialize state, fetch-bootstrap harvests it and returns to API replay.</p>
            </div>
            <div className="artifact-stack" aria-label="Generated artifacts">
              <article className="artifact"><small>Fast path</small><h3>workflow.json</h3><p>Structured API replay with named state captures for low-latency tasks and cron jobs.</p></article>
              <article className="artifact"><small>Fallback path</small><h3>playbook.yaml</h3><p>DOM-level steps for sites that move logic into the browser.</p></article>
              <article className="artifact"><small>Agent interface</small><h3>index.ts MCP tool</h3><p>Typed inputs, structured outputs, and an installable MCP server for local tools or checked-in examples.</p></article>
              <article className="artifact"><small>Optional</small><h3>request-transform.ts</h3><p>URL signing or request mutation when the API requires per-call tokens (HMAC, CRC32, OAuth).</p></article>
            </div>
          </section>

          <section className="section comparison" id="comparison" aria-labelledby="comparison-title">
            <div className="section-head">
              <div>
                <span className="kicker">Why Imprint</span>
                <h2 id="comparison-title">Compile-time exploration. Runtime certainty.</h2>
              </div>
              <p>Imprint is not another live browser agent. It is a memory layer for browser workflows your agents need to repeat reliably.</p>
            </div>
            <div className="comparison-grid">
              <aside className="backend-card" aria-label="Backend ladder speeds">
                <h3>The backend ladder</h3>
                <p className="problem-copy">Start with the fastest replay that works. Escalate only when the workflow or site forces it.</p>
                <div className="ladder">
                  <div className="ladder-row"><b>fetch</b><span>~200ms</span></div>
                  <div className="ladder-row"><b>fetch-bootstrap</b><span>browser state mint</span></div>
                  <div className="ladder-row"><b>cdp-replay</b><span>~2-5s warm · multi-step anti-bot</span></div>
                  <div className="ladder-row"><b>stealth-fetch</b><span>~12s first · ~1s warm</span></div>
                  <div className="ladder-row"><b>playbook</b><span>~9s universal fallback</span></div>
                </div>
              </aside>
              <table className="table-card">
                <caption className="sr-only">Comparison with live browser agents</caption>
                <thead>
                  <tr>
                    <th className="sr-only" scope="col">Criterion</th>
                    <th className="sr-only" scope="col">Imprint</th>
                    <th className="sr-only" scope="col">Live browser agents</th>
                  </tr>
                </thead>
                <tbody>
                  {comparisons.map((row) => (
                    <tr className="comparison-row" key={row[0]}>
                      <th className="label" scope="row">{row[0]}</th>
                      <td className="win"><strong>Imprint:</strong> {row[1]}</td>
                      <td className="other"><strong>Live browser agents:</strong> {row[2]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="examples" id="examples" aria-labelledby="examples-title">
            <div className="section">
              <div className="section-head">
                <div>
                  <span className="kicker">Working examples</span>
                  <h2 id="examples-title">Real sites, real friction, real replay.</h2>
                </div>
                <p>Imprint ships with examples that exercise bot protection, batchexecute nested-array parsing, authenticated flows, notifications, and MCP smoke testing. Install any example directly with <code>imprint install --source examples</code>; browser-backed installs fetch Playwright Chromium automatically. Share your own generated MCP folder and register it with <code>imprint install &lt;site&gt;</code>.</p>
              </div>
              <div className="example-grid">
                {examples.map((example) => (
                  <article className="example-card" key={example.name}>
                    <div>
                      <span className="tag">examples/{example.name}</span>
                      <h3>{example.name}</h3>
                    </div>
                    <div>
                      <p><strong>{example.use}</strong><br />{example.detail}</p>
                    </div>
                  </article>
                ))}
              </div>
              <div className="example-install" aria-label="Example install commands">
                <div className="command"><b>Try example</b><code>{product.installExample}</code></div>
                <div className="command"><b>Share MCP</b><code>{product.shareMcp}</code></div>
              </div>
            </div>
          </section>

          <section className="section security" aria-labelledby="security-title">
            <div className="security-grid">
              <article className="security-card">
                <span className="kicker">Security posture</span>
                <h2 id="security-title">Made for real sessions, not toy demos.</h2>
                <p>Imprint records sensitive browser traffic, so the product treats redaction, credentials, cookies, and storage as first-class workflow steps rather than README footnotes.</p>
              </article>
              <div className="checks">
                <div className="check"><i>✓</i><div><b>Redaction before compile</b><span><code>generate</code> and <code>compile-playbook</code> auto-redact sessions; equality markers preserve state relationships without exposing raw values.</span></div></div>
                <div className="check"><i>✓</i><div><b>Credentials stay local</b><span>Generated tools initialize per-run cookie/state jars from the local credential backend instead of committing plaintext secrets.</span></div></div>
                <div className="check"><i>✓</i><div><b>Traceable compiles</b><span><code>IMPRINT_TRACE=1</code> streams OpenInference spans, token estimates, and optional LLM/tool I/O into local Phoenix.</span></div></div>
                <div className="check"><i>✓</i><div><b>Auditable artifacts</b><span>Workflow, playbook, cron config, backend order, and generated module are files you can inspect, test, and version.</span></div></div>
              </div>
            </div>
          </section>

          <section className="section install" id="install" aria-labelledby="install-title">
            <div className="install-panel">
              <div>
                <span className="kicker">Install</span>
                <h2 id="install-title">Teach your first agent tool in minutes.</h2>
                <p>Install via npm (requires Bun 1.3+) or download a standalone binary. Try a checked-in example first, then teach your own site and register the emitted MCP wherever your agent runs.</p>
                <div className="hero-actions">
                  <a className="btn btn-primary" href={product.githubUrl}>View on GitHub</a>
                  <Link className="btn btn-secondary" to="/docs/getting-started">Read getting started</Link>
                </div>
              </div>
              <div className="command-list" aria-label="Install commands">
                <div className="command"><b>1</b><code>{product.install}</code></div>
                <div className="command"><b>2</b><code>{product.installExample}</code></div>
                <div className="command"><b>3</b><code>{product.teach}</code></div>
                <div className="command"><b>4</b><code>{product.installMcp}</code></div>
              </div>
            </div>
          </section>
        </main>

        <footer>
          <div className="footer-inner">
            <span>Imprint · deterministic browser skills for AI agents</span>
            <div className="footer-links" aria-label="Footer links">
              <a href={product.githubUrl}>GitHub</a>
              <Link to="/docs/security">Security</Link>
              <a href="https://github.com/ashaychangwani/imprint/blob/main/CONTRIBUTING.md">Contributing</a>
              <a href="https://github.com/ashaychangwani/imprint/blob/main/LICENSE">MIT License</a>
            </div>
          </div>
        </footer>
      </div>
    </>
  );
}
