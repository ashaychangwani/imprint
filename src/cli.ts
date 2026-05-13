#!/usr/bin/env bun
/** CLI entry point. Run `imprint --help` for the verb list. */

import { basename, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import type { ProviderName } from './imprint/llm.ts';
import { isDebug } from './imprint/log.ts';
import { shutdownTracing, traced } from './imprint/tracing.ts';
import { VERSION } from './imprint/version.ts';

const HELP = `imprint v${VERSION} — teach an AI agent to use any website. Once.

USAGE
  imprint <verb> [args]
  imprint <verb> --help    Per-verb help with flags and examples.

CAPTURE
  record <site>            Drive a workflow in Chromium, capture session.
  teach <site>             Record + compile + emit in one flow. <site> is a label you pick.
  redact <session.json>    Scrub credentials + PII before LLM analysis.

COMPILE
  generate <session>       Session → workflow.json (API replay).
  compile-playbook <sess>  Session → playbook.yaml (DOM replay).
  emit <workflow.json>     workflow.json → ~/.imprint/<site>/<toolName>/index.ts.
  probe-backends <site>    Try each backend once, cache the working order.

RUN
  mcp-server <site>        Serve one site's tools as MCP (stdio default).
  cron <site>              Polling daemon for ~/.imprint/<site>/<toolName>/cron.json.
  playbook <site>          Run a playbook directly (debugging).

OTHER
  doctor                   Check that the environment is set up correctly.
  assemble <session.jsonl> Recover session.json from a partial JSONL.
  check <session>          Sanity-check a captured session.
  login <site>             Persist cookies for <site> from a session.
  credential <subcmd>      Manage stored credentials (list/get/set/delete/export/import/migrate).

GLOBAL
  --help, -h               Show this help.
  --version, -v            Print version.

Quick start: docs/getting-started.md
Full docs:   docs/architecture.md, docs/glossary.md, docs/decisions.md
`;

export interface VerbHelp {
  summary: string;
  usage: string[];
  flags?: Array<{ name: string; description: string }>;
  example: string;
}

export const VERB_HELP: Record<string, VerbHelp> = {
  record: {
    summary: 'Drive a workflow in Chromium and stream the session to JSONL.',
    usage: ['imprint record <site> [--url <url>] [--persist-profile] [--out <path>]'],
    flags: [
      { name: '--url <url>', description: 'Starting URL (else about:blank — navigate manually).' },
      { name: '--out <path>', description: 'Override the JSONL output path.' },
      {
        name: '--persist-profile',
        description: 'Reuse a stable Chrome profile for this site (preserves login state).',
      },
    ],
    example: 'imprint record southwest --url https://www.southwest.com',
  },
  teach: {
    summary:
      'Record a workflow, compile both artifacts, emit the tool, and connect to your AI platform — all in one interactive flow. Supports resuming incomplete runs and multiple workflows per site.',
    usage: [
      'imprint teach <site> [--url <url>] [--from-session <path>] [--persist-profile] [--no-interactive] [--all-tools] [--provider <name>] [--keep-test]',
    ],
    flags: [
      { name: '--url <url>', description: 'Starting URL (else about:blank).' },
      {
        name: '--from-session <path>',
        description: 'Skip recording; use an existing session file to compile from.',
      },
      { name: '--persist-profile', description: 'Reuse a stable Chrome profile for this site.' },
      {
        name: '--no-interactive',
        description:
          'Run without prompts; compile the primary detected tool and print integration snippets.',
      },
      {
        name: '--all-tools',
        description:
          'With --no-interactive, compile every detected candidate tool instead of only the primary.',
      },
      {
        name: '--provider <name>',
        description:
          'Compile-agent provider: anthropic-api, vertex, claude-cli, codex-cli (auto-detected if omitted).',
      },
      {
        name: '--keep-test',
        description:
          'Retain the agent-generated parser.test.ts after compile (debug). Default deletes it; the test reads the gitignored redacted session via $IMPRINT_SESSION_PATH and is not portable.',
      },
    ],
    example: 'imprint teach google-flights --url https://flights.google.com',
  },
  doctor: {
    summary: 'Check that the environment is set up correctly (Bun, Chromium, Vertex env, push).',
    usage: ['imprint doctor'],
    example: 'imprint doctor',
  },
  assemble: {
    summary: 'Reconstruct session.json from a partial session.jsonl.',
    usage: ['imprint assemble <session.jsonl>'],
    example: 'imprint assemble ~/.imprint/mysite/sessions/2026-05-03T22-00-00Z.jsonl',
  },
  check: {
    summary: 'Sanity-check a captured session for completeness.',
    usage: ['imprint check <session.json | session.jsonl>'],
    example: 'imprint check ~/.imprint/acmecorp/sessions/2026-05-03T22-00-00Z.json',
  },
  redact: {
    summary: 'Scrub credentials + PII; write <session>.redacted.json.',
    usage: ['imprint redact <session.json> [--keep-header <name>]…'],
    flags: [
      {
        name: '--keep-header <name>',
        description:
          'Keep this header un-redacted (repeatable). Use when a non-credential header has a "secret" name.',
      },
    ],
    example: 'imprint redact ~/.imprint/acmecorp/sessions/<ts>.json',
  },
  generate: {
    summary: 'LLM-compile a session into workflow.json (API replay artifact).',
    usage: [
      'imprint generate <session.json> [--out <path>] [--max-duration <time>] [--provider <name>] [--keep-test]',
    ],
    flags: [
      { name: '--out <path>', description: 'Override the workflow.json output path.' },
      {
        name: '--max-duration <time>',
        description: 'Agent timeout (e.g., "30m", "1h", "300s"). Default 30m.',
      },
      {
        name: '--provider <name>',
        description:
          'Compile-agent provider: anthropic-api, vertex, claude-cli, codex-cli (auto-detected if omitted).',
      },
      {
        name: '--keep-test',
        description:
          'Retain the agent-generated parser.test.ts after compile (debug). Default deletes it; the test reads the gitignored redacted session via $IMPRINT_SESSION_PATH and is not portable.',
      },
    ],
    example: 'imprint generate ~/.imprint/acmecorp/sessions/<ts>.redacted.json',
  },
  'compile-playbook': {
    summary: 'LLM-compile a session into playbook.yaml (DOM replay artifact).',
    usage: [
      'imprint compile-playbook <session.json> [--out <path>] [--no-shrink] [--provider <name>]',
    ],
    flags: [
      { name: '--out <path>', description: 'Override the playbook.yaml output path.' },
      {
        name: '--no-shrink',
        description: 'Skip LLM-based triage; send all XHR/Fetch requests (debugging).',
      },
      {
        name: '--provider <name>',
        description:
          'LLM provider: anthropic-api, vertex, claude-cli, codex-cli, cursor-cli (auto-detected if omitted).',
      },
    ],
    example: 'imprint compile-playbook ~/.imprint/acmecorp/sessions/<ts>.redacted.json',
  },
  emit: {
    summary: 'Generate the executable TS module from workflow.json.',
    usage: ['imprint emit <workflow.json> [--out-dir <dir>] [--force]'],
    flags: [
      { name: '--out-dir <dir>', description: 'Override the output directory.' },
      { name: '--force', description: 'Overwrite an existing index.ts.' },
    ],
    example: 'imprint emit ~/.imprint/acmecorp/my-workflow/workflow.json',
  },
  login: {
    summary: 'Persist auth cookies for <site> from a captured session.',
    usage: ['imprint login <site> --from-session <session.json>'],
    flags: [
      { name: '--from-session <path>', description: 'Source session.json (required in v0.1).' },
    ],
    example:
      'imprint login discoverandgo --from-session ~/.imprint/discoverandgo/sessions/<ts>.json',
  },
  credential: {
    summary:
      'Manage local credential storage. Subcommands: list, get, set, delete, export, import, migrate.',
    usage: [
      'imprint credential list [<site>]',
      'imprint credential get <site> <name> --reveal',
      'imprint credential set <site> <name>',
      'imprint credential delete <site> <name>',
      'imprint credential export <site> [--out <path>]',
      'imprint credential import <site> <bundle-path>',
      'imprint credential migrate',
    ],
    example: 'imprint credential set southwest-seats password',
  },
  'probe-backends': {
    summary: 'Try each backend once and cache the working order to backends.json.',
    usage: ['imprint probe-backends <site> [--tool <toolName>] [--out <path>] [--param k=v]…'],
    flags: [
      { name: '--tool <toolName>', description: 'Select a generated tool for multi-tool sites.' },
      { name: '--out <path>', description: 'Override backends.json output path.' },
      { name: '--param k=v', description: 'Override a workflow parameter (repeatable).' },
    ],
    example: 'imprint probe-backends southwest --tool search_flights',
  },
  playbook: {
    summary: 'Run a playbook against a real Chromium (debugging).',
    usage: ['imprint playbook <site> [--headed] [--trace] [--path <yaml>] [--param k=v]…'],
    flags: [
      { name: '--headed', description: 'Show the browser window (default headless).' },
      { name: '--trace', description: 'Screenshot after every step.' },
      { name: '--path <yaml>', description: 'Override the playbook.yaml path.' },
      { name: '--param k=v', description: 'Set a playbook parameter (repeatable).' },
    ],
    example:
      'imprint playbook southwest --param origin_airport_code=SJC --param destination_airport_code=SAN',
  },
  cron: {
    summary:
      'Polling daemon for cron.json next to a generated tool at ~/.imprint/<site>/<toolName>/cron.json.',
    usage: [
      'imprint cron <site> [--tool <toolName>] [--once | --run-now] [--config <path>] [--quiet]',
    ],
    flags: [
      { name: '--tool <toolName>', description: 'Select a generated tool for multi-tool sites.' },
      { name: '--once', description: 'Run a single tick and exit (for OS schedulers).' },
      { name: '--run-now', description: 'Run once immediately, then continue scheduling.' },
      { name: '--config <path>', description: 'Override the cron.json path.' },
      {
        name: '--quiet',
        description:
          'Suppress logs on successful runs (errors still surface). For OS schedulers that mail on stderr.',
      },
    ],
    example: 'imprint cron southwest --tool search_flights --once --quiet',
  },
  'mcp-server': {
    summary: "Serve one site's generated tools as MCP (stdio default).",
    usage: ['imprint mcp-server <site> [--http] [--port <num>]'],
    flags: [
      { name: '--http', description: 'Use Streamable HTTP transport instead of stdio.' },
      { name: '--port <num>', description: 'Port for HTTP transport (default 8765).' },
    ],
    example: 'imprint mcp-server southwest',
  },
};

function printVerbHelp(verb: string): void {
  const h = VERB_HELP[verb];
  if (!h) {
    console.error(`No help for unknown verb: ${verb}`);
    return;
  }
  console.log(`imprint ${verb} — ${h.summary}\n`);
  console.log('USAGE');
  for (const u of h.usage) console.log(`  ${u}`);
  if (h.flags && h.flags.length > 0) {
    console.log('\nFLAGS');
    const pad = Math.max(...h.flags.map((f) => f.name.length));
    for (const f of h.flags) console.log(`  ${f.name.padEnd(pad)}  ${f.description}`);
  }
  console.log('\nEXAMPLE');
  console.log(`  ${h.example}\n`);
}

function isVerbHelpRequest(argv: string[]): boolean {
  return argv.includes('--help') || argv.includes('-h');
}

/** Pull `argv[1]` or print a uniform error and return null for early-return. */
function requirePositional(argv: string[], verb: string, label: string): string | null {
  const v = argv[1];
  if (!v) {
    console.error(
      `error: \`imprint ${verb}\` requires ${label}\n→ run \`imprint ${verb} --help\` for usage.`,
    );
    return null;
  }
  if (v.startsWith('-')) {
    console.error(
      `error: \`imprint ${verb}\` requires a <site> name before any flags.\n  <site> is a label you choose — it names the output folder under ~/.imprint/.\n\n  example: imprint ${verb} google-flights --url https://flights.google.com\n→ run \`imprint ${verb} --help\` for usage.`,
    );
    return null;
  }
  return v;
}

/** Parse `--param k=v` entries; coerces only well-formed decimal numbers
 *  and booleans, leaves everything else as strings. Returns null and prints
 *  an error on malformed input — caller returns its own exit code.
 *
 *  Numeric coercion is intentionally stricter than `Number(v)`:
 *  - Leading zeros stay strings ("0123" → "0123", not 123) so airport / ZIP /
 *    library-card codes survive.
 *  - "Infinity" / "-Infinity" / "NaN" stay strings (Number() accepts them).
 *  - Empty / whitespace stays as the literal string.
 *  - Hex / binary / octal literals stay strings.
 *  Pattern matches: optional minus, single 0 or non-zero-leading digits,
 *  optional .digits, optional eN exponent. */
const NUMERIC_PARAM_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export function tryParseParamKV(
  entries: string[] | undefined,
): Record<string, string | number | boolean> | null {
  const out: Record<string, string | number | boolean> = {};
  for (const kv of entries ?? []) {
    const eq = kv.indexOf('=');
    if (eq === -1) {
      console.error(
        `error: --param requires k=v form, got "${kv}"\n→ example: --param origin_airport_code=SJC`,
      );
      return null;
    }
    const k = kv.slice(0, eq);
    const v = kv.slice(eq + 1);
    if (v === 'true' || v === 'false') out[k] = v === 'true';
    else if (NUMERIC_PARAM_RE.test(v)) out[k] = Number(v);
    else out[k] = v;
  }
  return out;
}

export function inferPlaybookSiteForSmokeCommand(playbookPath: string, toolName: string): string {
  const parent = basename(dirname(playbookPath));
  if (!parent) return '<site>';
  if (parent === toolName) {
    const grandparent = basename(dirname(dirname(playbookPath)));
    return grandparent || '<site>';
  }
  return parent;
}

async function main(argv: string[]): Promise<number> {
  const verb = argv[0];

  if (!verb || verb === '--help' || verb === '-h' || verb === 'help') {
    console.log(HELP);
    return 0;
  }
  if (verb === '--version' || verb === '-v') {
    console.log(VERSION);
    return 0;
  }

  // Per-verb help: `imprint <verb> --help` or `-h`.
  if (verb in VERB_HELP && isVerbHelpRequest(argv.slice(1))) {
    printVerbHelp(verb);
    return 0;
  }

  switch (verb) {
    case 'record': {
      const site = requirePositional(argv, 'record', 'a <site> argument');
      if (site === null) return 2;
      const { record } = await import('./imprint/record.ts');
      const { values } = parseArgs({
        args: argv.slice(2),
        options: {
          url: { type: 'string' },
          out: { type: 'string' },
          'persist-profile': { type: 'boolean' },
        },
        allowPositionals: false,
      });

      // SIGINT → AbortController so the recorder flushes files before exit.
      const ctrl = new AbortController();
      const onSigint = (): void => ctrl.abort();
      process.once('SIGINT', onSigint);

      try {
        await record({
          site,
          url: values.url,
          outPath: values.out,
          persistProfile: values['persist-profile'],
          signal: ctrl.signal,
        });
      } finally {
        process.removeListener('SIGINT', onSigint);
      }
      return 0;
    }

    case 'doctor': {
      const { doctor, reportDoctor } = await import('./imprint/doctor.ts');
      const report = reportDoctor(doctor());
      for (const line of report.lines) console.log(line);
      return report.ok ? 0 : 1;
    }

    case 'assemble': {
      const jsonlPath = requirePositional(argv, 'assemble', 'a <session.jsonl> argument');
      if (jsonlPath === null) return 2;
      const { assembleFromJsonl } = await import('./imprint/session-writer.ts');
      const { writeFileSync } = await import('node:fs');
      const session = assembleFromJsonl(jsonlPath);
      const outPath = jsonlPath.replace(/\.jsonl$/, '.json');
      writeFileSync(outPath, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
      console.log(`[imprint] assembled → ${outPath}`);
      console.log(
        `[imprint] ${session.requests.length} requests, ${session.events.length} events, ${session.narration.length} narration lines`,
      );
      console.log('');
      console.log('next step:');
      console.log(`  imprint check ${outPath}    # sanity-check what was captured`);
      return 0;
    }

    case 'check': {
      const sessionPath = requirePositional(
        argv,
        'check',
        'a <session.json> or <session.jsonl> argument',
      );
      if (sessionPath === null) return 2;
      const { checkSession, reportCheck } = await import('./imprint/check.ts');
      const result = checkSession(sessionPath);
      reportCheck(sessionPath, result);
      return result.ok ? 0 : 1;
    }

    case 'redact': {
      const sessionPath = requirePositional(argv, 'redact', 'a <session.json> argument');
      if (sessionPath === null) return 2;
      const { values } = parseArgs({
        args: argv.slice(2),
        options: { 'keep-header': { type: 'string', multiple: true } },
        allowPositionals: false,
      });
      const { writeFileSync } = await import('node:fs');
      const { SessionSchema } = await import('./imprint/types.ts');
      const { redactSession } = await import('./imprint/redact.ts');
      const { loadJsonFile } = await import('./imprint/load-json.ts');
      let session: ReturnType<typeof SessionSchema.parse>;
      try {
        session = loadJsonFile(
          sessionPath,
          SessionSchema,
          {
            notFound: '→ run `imprint record <site>` to capture one.',
            notJson: `→ if this is a .jsonl from a crashed recording, run \`imprint assemble ${sessionPath}\` first.`,
            badSchema: '→ hand-edited session files often drift; re-record if needed.',
          },
          'session',
        );
      } catch (err) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        return 2;
      }
      const keepHeaders = values['keep-header'] ?? [];
      const { session: scrubbed, stats } = redactSession(session, { keepHeaders });
      const outPath = sessionPath.replace(/\.json$/, '.redacted.json');
      writeFileSync(outPath, `${JSON.stringify(scrubbed, null, 2)}\n`, 'utf8');
      console.log(`[imprint] redacted → ${outPath}`);
      const freeformNote =
        stats.freeformRedactions > 0
          ? ` (${stats.freeformRedactions} free-form finding${stats.freeformRedactions === 1 ? '' : 's'})`
          : '';
      console.log(
        `[imprint] ${stats.totalRedactions} value${stats.totalRedactions === 1 ? '' : 's'} replaced across ${stats.requestsRedacted} request${stats.requestsRedacted === 1 ? '' : 's'} and ${stats.cookiesRedacted} cookie${stats.cookiesRedacted === 1 ? '' : 's'}${freeformNote}`,
      );
      if (keepHeaders.length > 0) {
        console.log(`[imprint] kept (not redacted): ${keepHeaders.join(', ')}`);
      }
      for (const w of stats.warnings) {
        console.log(`[imprint]   ⚠ ${w}`);
      }
      console.log('');
      console.log('next step:');
      console.log(`  imprint generate ${outPath}    # LLM → workflow.json`);
      return 0;
    }

    case 'generate': {
      const sessionPath = requirePositional(argv, 'generate', 'a <session.json> argument');
      if (sessionPath === null) return 2;
      const { values } = parseArgs({
        args: argv.slice(2),
        options: {
          out: { type: 'string' },
          'max-duration': { type: 'string' },
          provider: { type: 'string' },
          'keep-test': { type: 'boolean' },
        },
        allowPositionals: false,
      });

      if (values.provider) {
        const { isTeachCompatibleProvider, isValidProvider } = await import('./imprint/llm.ts');
        if (!isValidProvider(values.provider)) {
          console.error(
            `error: unknown provider '${values.provider}' — valid: anthropic-api, vertex, claude-cli, codex-cli, cursor-cli`,
          );
          return 2;
        }
        if (!isTeachCompatibleProvider(values.provider)) {
          console.error(
            `error: provider '${values.provider}' is not supported for generate — use anthropic-api, vertex, claude-cli, or codex-cli`,
          );
          return 2;
        }
      }

      // Parse --max-duration: "Nm" (minutes), "Nh" (hours), "Ns" (seconds), plain N (ms)
      let maxDurationMs: number | undefined;
      if (values['max-duration']) {
        const dur = values['max-duration'];
        const match = dur.match(/^(\d+)(m|h|s|ms)?$/);
        if (!match) {
          console.error(
            `error: invalid --max-duration "${dur}"\n→ use format: 30m, 1h, 300s, or plain milliseconds`,
          );
          return 2;
        }
        const num = Number.parseInt(match[1] ?? '0', 10);
        const unit = match[2] ?? 'ms';
        if (unit === 'h') maxDurationMs = num * 60 * 60 * 1000;
        else if (unit === 'm') maxDurationMs = num * 60 * 1000;
        else if (unit === 's') maxDurationMs = num * 1000;
        else maxDurationMs = num;
      }

      const { generate } = await import('./imprint/compile.ts');
      const { detectTeachProvider } = await import('./imprint/llm.ts');
      const { resolveCompileAgentModel } = await import('./imprint/compile-agent.ts');
      const { describeAgentActivity, formatElapsed } = await import('./imprint/progress.ts');

      // Resolve provider + model NOW so we can tell the user before silence
      // sets in (the agent loop typically runs 3-5 min with no other output).
      const providerName = (values.provider as ProviderName | undefined) ?? detectTeachProvider();
      const compileModel = resolveCompileAgentModel(providerName);
      console.error('');
      console.error(`[imprint compile] provider: ${providerName}    model: ${compileModel}`);
      console.error(
        '[imprint compile] An LLM agent will reverse-engineer the API response format.',
      );
      console.error(
        '[imprint compile] Expect ~3-5 minutes and moderate to high token use, depending on',
      );
      console.error('[imprint compile] the complexity of the recording.');
      console.error('');

      // Stream one stderr line per *changed* activity so non-TTY runs (CI,
      // piped, backgrounded) get visibility instead of silence.
      let lastActivity = '';
      const result = await generate({
        sessionPath,
        outPath: values.out,
        maxDurationMs,
        llmConfig: { provider: providerName, model: compileModel },
        keepTest: values['keep-test'],
        onProgress: (p) => {
          const activity = describeAgentActivity(p);
          if (activity === lastActivity) return;
          lastActivity = activity;
          const retry = p.verificationCycle > 1 ? ` (retry ${p.verificationCycle - 1})` : '';
          process.stderr.write(
            `[imprint compile] ${formatElapsed(p.elapsedMs)} — ${activity}${retry}\n`,
          );
        },
      });
      console.log('');
      console.log(`[imprint] workflow → ${result.workflowPath}`);
      console.log(
        `[imprint] tool: ${result.workflow.toolName} (${result.workflow.requests.length} request${result.workflow.requests.length === 1 ? '' : 's'}, ${result.workflow.parameters.length} parameter${result.workflow.parameters.length === 1 ? '' : 's'})`,
      );
      console.log(
        `[imprint] tokens: ${result.inputTokens ?? 'N/A'} in, ${result.outputTokens ?? 'N/A'} out — ${(result.durationMs / 1000).toFixed(1)}s`,
      );
      console.log('');
      console.log('next step:');
      console.log(`  imprint emit ${result.workflowPath}    # codegen the runtime tool`);
      return 0;
    }

    case 'emit': {
      const workflowPath = requirePositional(argv, 'emit', 'a <workflow.json> argument');
      if (workflowPath === null) return 2;
      const { values } = parseArgs({
        args: argv.slice(2),
        options: { force: { type: 'boolean' }, 'out-dir': { type: 'string' } },
        allowPositionals: false,
      });
      const { emit } = await import('./imprint/emit.ts');
      const result = emit({
        workflowPath,
        outDir: values['out-dir'],
        force: values.force,
      });
      console.log(`[imprint] generated → ${result.outPath}`);
      console.log(
        `[imprint] tool: ${result.toolName} (${result.parameters.length} parameter${result.parameters.length === 1 ? '' : 's'})`,
      );
      // Surface what to do next so users don't have to alt-tab to docs.
      const site = result.outPath.split('/').slice(-3, -2)[0] ?? '<site>';
      console.log('');
      console.log('next steps:');
      console.log(
        `  imprint probe-backends ${site} --tool ${result.toolName}    # cache the working backend order`,
      );
      console.log(`  imprint mcp-server ${site}        # expose this site's tool as MCP`);
      console.log(
        `  imprint cron ${site} --tool ${result.toolName} --once       # one-shot test (after creating cron.json)`,
      );
      return 0;
    }

    case 'login': {
      const site = requirePositional(argv, 'login', 'a <site> argument');
      if (site === null) return 2;
      const { values } = parseArgs({
        args: argv.slice(2),
        options: { 'from-session': { type: 'string' } },
        allowPositionals: false,
      });
      if (!values['from-session']) {
        console.error(
          'error: v0.1 of `imprint login` requires --from-session <session.json>. Capture a session via `imprint record` first, then point login at it.',
        );
        return 2;
      }
      const { login } = await import('./imprint/login.ts');
      const result = await login({
        site,
        fromSession: values['from-session'],
      });
      console.log(`[imprint] credentials → backend: ${result.backend}`);
      console.log(
        `[imprint] ${result.cookieCount} cookie${result.cookieCount === 1 ? '' : 's'} stored`,
      );
      console.log(
        `[imprint] ${Object.keys(result.values).length} value${Object.keys(result.values).length === 1 ? '' : 's'} extracted: ${Object.keys(result.values).join(', ') || '(none)'}`,
      );
      if (result.matchedExtractors.length > 0) {
        console.log(`[imprint] extractors matched: ${result.matchedExtractors.join(', ')}`);
      }
      console.log('');
      console.log(
        `[imprint] credentials are loaded automatically by \`imprint cron ${site}\` and \`imprint mcp-server\` — no extra wiring needed.`,
      );
      return 0;
    }

    case 'mcp-server': {
      const site = requirePositional(argv, 'mcp-server', 'a <site> argument');
      if (site === null) return 2;
      const { values } = parseArgs({
        args: argv.slice(2),
        options: {
          http: { type: 'boolean' },
          port: { type: 'string' },
        },
        allowPositionals: false,
      });
      const { runMcpServer } = await import('./imprint/mcp-server.ts');
      await runMcpServer({
        site,
        http: values.http,
        port: values.port ? Number(values.port) : undefined,
      });
      return 0;
    }

    case 'cron': {
      const site = requirePositional(argv, 'cron', 'a <site> argument');
      if (site === null) return 2;
      const { values } = parseArgs({
        args: argv.slice(2),
        options: {
          config: { type: 'string' },
          tool: { type: 'string' },
          once: { type: 'boolean' },
          'run-now': { type: 'boolean' },
          quiet: { type: 'boolean' },
        },
        allowPositionals: false,
      });
      const { runCron } = await import('./imprint/cron.ts');
      await runCron({
        site,
        configPath: values.config,
        toolName: values.tool,
        once: values.once,
        runNow: values['run-now'],
        // --quiet suppresses successful-run logs so OS schedulers
        // (cron, systemd, launchd) don't mail noise on green runs.
        // runCron scopes the env mutation to its own lifetime.
        quiet: values.quiet,
      });
      return 0;
    }

    case 'probe-backends': {
      const site = requirePositional(argv, 'probe-backends', 'a <site> argument');
      if (site === null) return 2;
      const { values } = parseArgs({
        args: argv.slice(2),
        options: {
          out: { type: 'string' },
          tool: { type: 'string' },
          param: { type: 'string', multiple: true },
        },
        allowPositionals: false,
      });
      const overrides = tryParseParamKV(values.param);
      if (overrides === null) return 2;
      const { probeBackends } = await import('./imprint/probe-backends.ts');
      const result = await probeBackends({
        site,
        outPath: values.out,
        toolName: values.tool,
        paramOverrides: Object.keys(overrides).length > 0 ? overrides : undefined,
      });
      console.log(`[imprint] probed → ${result.outPath}`);
      console.log(`[imprint] preferred order: ${result.cache.preferredOrder.join(' → ')}`);
      console.log('');
      console.log('[imprint] cron + mcp-server now skip futile rungs at startup using this cache.');
      return 0;
    }

    case 'compile-playbook': {
      const sessionPath = requirePositional(argv, 'compile-playbook', 'a <session.json> argument');
      if (sessionPath === null) return 2;
      const { values } = parseArgs({
        args: argv.slice(2),
        options: {
          out: { type: 'string' },
          'no-shrink': { type: 'boolean' },
          provider: { type: 'string' },
        },
        allowPositionals: false,
      });

      if (values.provider) {
        const { isValidProvider } = await import('./imprint/llm.ts');
        if (!isValidProvider(values.provider)) {
          console.error(
            `error: unknown provider '${values.provider}' — valid: anthropic-api, vertex, claude-cli, codex-cli, cursor-cli`,
          );
          return 2;
        }
      }

      const { compilePlaybook } = await import('./imprint/compile.ts');
      const result = await compilePlaybook({
        sessionPath,
        outPath: values.out,
        noShrink: values['no-shrink'],
        llmConfig: values.provider ? { provider: values.provider as ProviderName } : undefined,
      });
      console.log(`[imprint] playbook → ${result.playbookPath}`);
      console.log(
        `[imprint] tool: ${result.playbook.toolName} (${result.playbook.steps.length} step${result.playbook.steps.length === 1 ? '' : 's'}, ${result.playbook.parameters.length} parameter${result.playbook.parameters.length === 1 ? '' : 's'})`,
      );
      console.log(
        `[imprint] tokens: ${result.inputTokens ?? 'N/A'} in, ${result.outputTokens ?? 'N/A'} out — ${(result.durationMs / 1000).toFixed(1)}s`,
      );
      // Suggest a smoke run; the playbook is most useful behind the cron ladder.
      const playbookSite = inferPlaybookSiteForSmokeCommand(
        result.playbookPath,
        result.playbook.toolName,
      );
      console.log('');
      console.log('next step:');
      console.log(
        `  imprint playbook ${playbookSite} --param k=v  # smoke-test the playbook directly`,
      );
      return 0;
    }

    case 'playbook': {
      const site = requirePositional(argv, 'playbook', 'a <site> argument');
      if (site === null) return 2;
      const { values } = parseArgs({
        args: argv.slice(2),
        options: {
          headed: { type: 'boolean' },
          trace: { type: 'boolean' },
          param: { type: 'string', multiple: true },
          path: { type: 'string' },
        },
        allowPositionals: false,
      });
      const { resolve: pathResolve } = await import('node:path');
      let playbookPath: string;
      if (values.path) {
        playbookPath = pathResolve(values.path);
      } else {
        const { discoverTools } = await import('./imprint/tool-loader.ts');
        const { imprintHomeDir, localToolDir } = await import('./imprint/paths.ts');
        const tools = await discoverTools(imprintHomeDir(), site);
        if (tools.length > 1) {
          console.error(
            `error: site "${site}" has ${tools.length} workflows — specify which with --path:\n${tools.map((t) => `  --path ${pathResolve(t.dir, 'playbook.yaml')}`).join('\n')}`,
          );
          return 2;
        }
        const tool = tools[0];
        playbookPath = tool
          ? pathResolve(tool.dir, 'playbook.yaml')
          : pathResolve(localToolDir(site, '<toolName>'), 'playbook.yaml');
      }
      const params = tryParseParamKV(values.param);
      if (params === null) return 2;
      const { runPlaybook } = await import('./imprint/playbook-runner.ts');
      const result = await runPlaybook({
        playbook: playbookPath,
        params,
        headed: values.headed,
        trace: values.trace,
        site,
      });
      if (result.ok) {
        console.log('[imprint] OK');
        console.log(JSON.stringify(result.data, null, 2));
        return 0;
      }
      console.error(`[imprint] ${result.error}: ${result.message}`);
      return 1;
    }

    case 'teach': {
      const rawSite = argv[1];
      let site: string | undefined;
      if (rawSite?.startsWith('-')) {
        // Looks like a flag — can't tell from a missing site, so error out
        // with the explanation regardless of interactive mode.
        console.error(
          'error: `imprint teach` requires a <site> name before any flags.\n  <site> is a label you choose — it names the output folder under ~/.imprint/.\n\n  example: imprint teach google-flights --url https://flights.google.com\n→ run `imprint teach --help` for usage.',
        );
        return 2;
      }
      if (rawSite) site = rawSite;

      const { values } = parseArgs({
        args: argv.slice(rawSite ? 2 : 1),
        options: {
          url: { type: 'string' },
          'from-session': { type: 'string' },
          'persist-profile': { type: 'boolean' },
          'no-interactive': { type: 'boolean' },
          'all-tools': { type: 'boolean' },
          provider: { type: 'string' },
          'keep-test': { type: 'boolean' },
        },
        allowPositionals: false,
      });

      if (!site && values['no-interactive']) {
        console.error(
          'error: `imprint teach` requires a <site> argument in --no-interactive mode.\n  <site> is a label you choose — it names the output folder under ~/.imprint/.\n\n  example: imprint teach google-flights --url https://flights.google.com\n→ run `imprint teach --help` for usage.',
        );
        return 2;
      }

      if (values.provider) {
        const { isValidProvider } = await import('./imprint/llm.ts');
        if (!isValidProvider(values.provider)) {
          console.error(
            `error: unknown provider '${values.provider}' — valid: anthropic-api, vertex, claude-cli, codex-cli, cursor-cli`,
          );
          return 2;
        }
      }

      const ctrl = new AbortController();
      const onSigint = (): void => ctrl.abort();
      process.once('SIGINT', onSigint);

      try {
        const { teach } = await import('./imprint/teach.ts');
        await traced(
          'cli.teach',
          'AGENT',
          {
            'imprint.site': site,
            'imprint.url': values.url,
            'imprint.from_session': values['from-session'],
            'imprint.provider': values.provider ?? 'auto',
            'imprint.all_tools': values['all-tools'] ?? false,
            'imprint.no_interactive': values['no-interactive'] ?? false,
          },
          () =>
            teach({
              site,
              url: values.url,
              fromSession: values['from-session'],
              persistProfile: values['persist-profile'],
              signal: ctrl.signal,
              noInteractive: values['no-interactive'],
              provider: values.provider as ProviderName | undefined,
              keepTest: values['keep-test'],
              allTools: values['all-tools'],
            }),
        );
      } finally {
        process.removeListener('SIGINT', onSigint);
      }
      return 0;
    }

    case 'credential': {
      const { runCredentialCommand } = await import('./imprint/cli-credential.ts');
      return await runCredentialCommand(argv.slice(1));
    }

    // Hidden verb: spawned by claude-cli-compile.ts via --mcp-config. Not in
    // VERB_HELP, not advertised. Double-underscore prefix marks it as internal.
    case '__mcp-compile-server': {
      const { values } = parseArgs({
        args: argv.slice(1),
        options: {
          'session-path': { type: 'string' },
          'tool-dir': { type: 'string' },
          'example-dir': { type: 'string' },
          'candidate-json': { type: 'string' },
          'shared-context-json': { type: 'string' },
        },
        allowPositionals: false,
      });
      const toolDir = values['tool-dir'] ?? values['example-dir'];
      if (!values['session-path'] || !toolDir) {
        console.error(
          'error: __mcp-compile-server requires --session-path <path> and --tool-dir <path>',
        );
        return 2;
      }
      const { runCompileMcpServer } = await import('./imprint/mcp-compile-server.ts');
      const { ToolCandidateSchema, SharedCompileContextSchema } = await import(
        './imprint/tool-candidates.ts'
      );
      const candidate = values['candidate-json']
        ? ToolCandidateSchema.parse(JSON.parse(values['candidate-json']))
        : undefined;
      const sharedContext = values['shared-context-json']
        ? SharedCompileContextSchema.parse(JSON.parse(values['shared-context-json']))
        : undefined;
      await runCompileMcpServer({
        sessionPath: values['session-path'],
        toolDir,
        candidate,
        sharedContext,
      });
      return 0;
    }

    default: {
      const suggestion = closestVerb(verb);
      const tail = suggestion ? `did you mean \`imprint ${suggestion}\`?` : 'run `imprint --help`';
      console.error(`error: unknown verb '${verb}' — ${tail}`);
      return 2;
    }
  }
}

/** Suggest the closest known verb to a typo via Levenshtein distance.
 *  Returns the suggestion only if it's plausibly close (≤ 3 edits). */
export function closestVerb(input: string): string | null {
  const verbs = Object.keys(VERB_HELP);
  let best: { verb: string; dist: number } | null = null;
  for (const v of verbs) {
    const d = levenshtein(input, v);
    if (best === null || d < best.dist) best = { verb: v, dist: d };
  }
  if (best === null) return null;
  // Require absolute distance ≤ 3 AND ≤ half the longer string's length —
  // catches typos and short truncations without suggesting wildly different verbs.
  const maxLen = Math.max(input.length, best.verb.length);
  if (best.dist > 3 || best.dist > Math.floor(maxLen / 2)) return null;
  return best.verb;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((curr[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j] ?? 0;
  }
  return prev[b.length] ?? a.length;
}

// Only run when invoked as the entry point — importing this module
// (e.g. for VERB_HELP from tests) must not trigger the CLI dispatch.
if (import.meta.main) {
  main(process.argv.slice(2))
    .then(async (code) => {
      await shutdownTracing();
      process.exit(code);
    })
    .catch(async (err) => {
      console.error('imprint: fatal:', err instanceof Error ? err.message : String(err));
      if (isDebug()) {
        console.error(err);
      }
      await shutdownTracing();
      process.exit(1);
    });
}
