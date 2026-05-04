#!/usr/bin/env bun
/** CLI entry point. Run `imprint --help` for the verb list. */

import { parseArgs } from 'node:util';
import { VERSION } from './imprint/version.ts';

const HELP = `imprint v${VERSION} — teach an AI agent to use any website. Once.

USAGE
  imprint <verb> [args]
  imprint <verb> --help    Per-verb help with flags and examples.

CAPTURE
  record <site>            Drive a workflow in Chromium, capture session.
  redact <session.json>    Scrub credentials + PII before LLM analysis.

COMPILE
  generate <session>       Session → workflow.json (API replay).
  compile-playbook <sess>  Session → playbook.yaml (DOM replay).
  emit <workflow.json>     workflow.json → examples/<site>/index.ts.
  probe-backends <site>    Try each backend once, cache the working order.

RUN
  mcp-server               Expose every generated tool as MCP (stdio default).
  cron <site>              Polling daemon for examples/<site>/cron.json.
  playbook <site>          Run a playbook directly (debugging).

OTHER
  doctor                   Check that the environment is set up correctly.
  assemble <session.jsonl> Recover session.json from a partial JSONL.
  check <session>          Sanity-check a captured session.
  login <site>             Persist cookies for <site> from a session.

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
    example: 'imprint record acmecorp --url https://app.acmecorp.com',
  },
  doctor: {
    summary: 'Check that the environment is set up correctly (Bun, Chromium, Vertex env, push).',
    usage: ['imprint doctor'],
    example: 'imprint doctor',
  },
  assemble: {
    summary: 'Reconstruct session.json from a partial session.jsonl.',
    usage: ['imprint assemble <session.jsonl>'],
    example: 'imprint assemble examples/mysite/sessions/2026-05-03T22-00-00Z.jsonl',
  },
  check: {
    summary: 'Sanity-check a captured session for completeness.',
    usage: ['imprint check <session.json | session.jsonl>'],
    example: 'imprint check examples/acmecorp/sessions/2026-05-03T22-00-00Z.json',
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
    example: 'imprint redact examples/acmecorp/sessions/<ts>.json',
  },
  generate: {
    summary: 'LLM-compile a session into workflow.json (API replay artifact).',
    usage: ['imprint generate <session.json> [--out <path>] [--no-shrink] [--save-shrunken]'],
    flags: [
      { name: '--out <path>', description: 'Override the workflow.json output path.' },
      { name: '--no-shrink', description: 'Send the FULL session to the LLM (debugging).' },
      {
        name: '--save-shrunken',
        description: 'Write the shrunken view next to workflow.json (prompt iteration).',
      },
    ],
    example: 'imprint generate examples/acmecorp/sessions/<ts>.redacted.json',
  },
  'compile-playbook': {
    summary: 'LLM-compile a session into playbook.yaml (DOM replay artifact).',
    usage: ['imprint compile-playbook <session.json> [--out <path>]'],
    flags: [{ name: '--out <path>', description: 'Override the playbook.yaml output path.' }],
    example: 'imprint compile-playbook examples/acmecorp/sessions/<ts>.redacted.json',
  },
  emit: {
    summary: 'Generate the executable TS module from workflow.json.',
    usage: ['imprint emit <workflow.json> [--out-dir <dir>] [--force]'],
    flags: [
      { name: '--out-dir <dir>', description: 'Override the output directory.' },
      { name: '--force', description: 'Overwrite an existing index.ts.' },
    ],
    example: 'imprint emit examples/acmecorp/workflow.json',
  },
  login: {
    summary: 'Persist auth cookies for <site> from a captured session.',
    usage: ['imprint login <site> --from-session <session.json>'],
    flags: [
      { name: '--from-session <path>', description: 'Source session.json (required in v0.1).' },
    ],
    example: 'imprint login discoverandgo --from-session examples/discoverandgo/sessions/<ts>.json',
  },
  'probe-backends': {
    summary: 'Try each backend once and cache the working order to backends.json.',
    usage: ['imprint probe-backends <site> [--out <path>] [--param k=v]…'],
    flags: [
      { name: '--out <path>', description: 'Override backends.json output path.' },
      { name: '--param k=v', description: 'Override a workflow parameter (repeatable).' },
    ],
    example: 'imprint probe-backends southwest',
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
    summary: 'Polling daemon for examples/<site>/cron.json.',
    usage: ['imprint cron <site> [--once | --run-now] [--config <path>]'],
    flags: [
      { name: '--once', description: 'Run a single tick and exit (for OS schedulers).' },
      { name: '--run-now', description: 'Run once immediately, then continue scheduling.' },
      { name: '--config <path>', description: 'Override the cron.json path.' },
    ],
    example: 'imprint cron southwest --once',
  },
  'mcp-server': {
    summary: 'Expose every generated tool as MCP (stdio default).',
    usage: ['imprint mcp-server [--site <name>] [--http] [--port <num>]'],
    flags: [
      { name: '--site <name>', description: 'Restrict to one example.' },
      { name: '--http', description: 'Use Streamable HTTP transport instead of stdio.' },
      { name: '--port <num>', description: 'Port for HTTP transport (default 8765).' },
    ],
    example: 'imprint mcp-server --site echo',
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
    console.error(`error: \`imprint ${verb}\` requires ${label}`);
    return null;
  }
  return v;
}

/** Parse `--param k=v` entries; coerces numeric/boolean values; throws on malformed input. */
function parseParamKV(entries: string[]): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const kv of entries) {
    const eq = kv.indexOf('=');
    if (eq === -1) throw new Error(`--param requires k=v form, got "${kv}"`);
    const k = kv.slice(0, eq);
    const v = kv.slice(eq + 1);
    if (v === 'true' || v === 'false') out[k] = v === 'true';
    else if (v !== '' && !Number.isNaN(Number(v))) out[k] = Number(v);
    else out[k] = v;
  }
  return out;
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
      const { readFileSync, writeFileSync } = await import('node:fs');
      const { SessionSchema } = await import('./imprint/types.ts');
      const { redactSession } = await import('./imprint/redact.ts');
      const raw = JSON.parse(readFileSync(sessionPath, 'utf8'));
      const session = SessionSchema.parse(raw);
      const keepHeaders = values['keep-header'] ?? [];
      const { session: scrubbed, stats } = redactSession(session, { keepHeaders });
      const outPath = sessionPath.replace(/\.json$/, '.redacted.json');
      writeFileSync(outPath, `${JSON.stringify(scrubbed, null, 2)}\n`, 'utf8');
      console.log(`[imprint] redacted → ${outPath}`);
      console.log(
        `[imprint] ${stats.totalRedactions} value${stats.totalRedactions === 1 ? '' : 's'} replaced across ${stats.requestsRedacted} request${stats.requestsRedacted === 1 ? '' : 's'} and ${stats.cookiesRedacted} cookie${stats.cookiesRedacted === 1 ? '' : 's'}`,
      );
      if (keepHeaders.length > 0) {
        console.log(`[imprint] kept (not redacted): ${keepHeaders.join(', ')}`);
      }
      for (const w of stats.warnings) {
        console.log(`[imprint]   ⚠ ${w}`);
      }
      return 0;
    }

    case 'generate': {
      const sessionPath = requirePositional(argv, 'generate', 'a <session.json> argument');
      if (sessionPath === null) return 2;
      const { values } = parseArgs({
        args: argv.slice(2),
        options: {
          out: { type: 'string' },
          'no-shrink': { type: 'boolean' },
          'save-shrunken': { type: 'boolean' },
        },
        allowPositionals: false,
      });
      const { generate } = await import('./imprint/compile.ts');
      const result = await generate({
        sessionPath,
        outPath: values.out,
        noShrink: values['no-shrink'],
        saveShrunken: values['save-shrunken'],
      });
      console.log('');
      console.log(`[imprint] workflow → ${result.workflowPath}`);
      console.log(
        `[imprint] tool: ${result.workflow.toolName} (${result.workflow.requests.length} request${result.workflow.requests.length === 1 ? '' : 's'}, ${result.workflow.parameters.length} parameter${result.workflow.parameters.length === 1 ? '' : 's'})`,
      );
      console.log(
        `[imprint] tokens: ${result.inputTokens} in, ${result.outputTokens} out — ${(result.durationMs / 1000).toFixed(1)}s`,
      );
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
      const site = result.outPath.split('/').slice(-2, -1)[0] ?? '<site>';
      console.log('');
      console.log('next steps:');
      console.log(`  imprint probe-backends ${site}    # cache the working backend order`);
      console.log('  imprint mcp-server                # expose every generated tool as MCP');
      console.log(`  imprint cron ${site} --once       # one-shot test (after creating cron.json)`);
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
      const result = login({
        site,
        fromSession: values['from-session'],
      });
      console.log(`[imprint] credentials → ${result.outPath}`);
      console.log(
        `[imprint] ${result.cookieCount} cookie${result.cookieCount === 1 ? '' : 's'} stored`,
      );
      console.log(
        `[imprint] ${Object.keys(result.values).length} value${Object.keys(result.values).length === 1 ? '' : 's'} extracted: ${Object.keys(result.values).join(', ') || '(none)'}`,
      );
      if (result.matchedExtractors.length > 0) {
        console.log(`[imprint] extractors matched: ${result.matchedExtractors.join(', ')}`);
      }
      return 0;
    }

    case 'mcp-server': {
      const { values } = parseArgs({
        args: argv.slice(1),
        options: {
          site: { type: 'string' },
          http: { type: 'boolean' },
          port: { type: 'string' },
        },
        allowPositionals: false,
      });
      const { runMcpServer } = await import('./imprint/mcp-server.ts');
      await runMcpServer({
        site: values.site,
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
          once: { type: 'boolean' },
          'run-now': { type: 'boolean' },
        },
        allowPositionals: false,
      });
      const { runCron } = await import('./imprint/cron.ts');
      await runCron({
        site,
        configPath: values.config,
        once: values.once,
        runNow: values['run-now'],
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
          param: { type: 'string', multiple: true },
        },
        allowPositionals: false,
      });
      let overrides: Record<string, string | number | boolean>;
      try {
        overrides = parseParamKV(values.param ?? []);
      } catch (err) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        return 2;
      }
      const { probeBackends } = await import('./imprint/probe-backends.ts');
      const result = await probeBackends({
        site,
        outPath: values.out,
        paramOverrides: Object.keys(overrides).length > 0 ? overrides : undefined,
      });
      console.log(`[imprint] probed → ${result.outPath}`);
      console.log(`[imprint] preferred order: ${result.cache.preferredOrder.join(' → ')}`);
      return 0;
    }

    case 'compile-playbook': {
      const sessionPath = requirePositional(argv, 'compile-playbook', 'a <session.json> argument');
      if (sessionPath === null) return 2;
      const { values } = parseArgs({
        args: argv.slice(2),
        options: { out: { type: 'string' } },
        allowPositionals: false,
      });
      const { compilePlaybook } = await import('./imprint/compile.ts');
      const result = await compilePlaybook({ sessionPath, outPath: values.out });
      console.log(`[imprint] playbook → ${result.playbookPath}`);
      console.log(
        `[imprint] tool: ${result.playbook.toolName} (${result.playbook.steps.length} step${result.playbook.steps.length === 1 ? '' : 's'}, ${result.playbook.parameters.length} parameter${result.playbook.parameters.length === 1 ? '' : 's'})`,
      );
      console.log(
        `[imprint] tokens: ${result.inputTokens} in, ${result.outputTokens} out — ${(result.durationMs / 1000).toFixed(1)}s`,
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
      const playbookPath =
        values.path ?? pathResolve(process.cwd(), 'examples', site, 'playbook.yaml');
      let params: Record<string, string | number | boolean>;
      try {
        params = parseParamKV(values.param ?? []);
      } catch (err) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        return 2;
      }
      const { runPlaybook } = await import('./imprint/playbook-runner.ts');
      const result = await runPlaybook({
        playbook: playbookPath,
        params,
        headed: values.headed,
        trace: values.trace,
      });
      if (result.ok) {
        console.log('[imprint] OK');
        console.log(JSON.stringify(result.data, null, 2));
        return 0;
      }
      console.error(`[imprint] ${result.error}: ${result.message}`);
      return 1;
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
function closestVerb(input: string): string | null {
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
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('imprint: fatal:', err instanceof Error ? err.message : String(err));
      if (process.env.IMPRINT_DEBUG) {
        console.error(err);
      }
      process.exit(1);
    });
}
