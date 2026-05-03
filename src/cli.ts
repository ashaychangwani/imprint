#!/usr/bin/env bun
/**
 * Imprint CLI entry point.
 *
 * Verbs:
 *   imprint record <site>            Open Chromium, capture a session, write session.json
 *   imprint generate <session.json>  Run LLM intent-detection, write workflow.json
 *   imprint emit <workflow.json>     Generate the MCP server TS module
 *   imprint login <site>             Open Chromium for user-driven login, persist cookies
 *   imprint cron <example>           Start the polling daemon for a generated workflow
 *   imprint mcp-server <example>     Speak MCP stdio protocol, exposing the workflow as a tool
 */

import { parseArgs } from 'node:util';

const VERSION = '0.1.0';

const HELP = `imprint v${VERSION} — teach AI agents to use any website

USAGE:
  imprint <verb> [args] [options]

VERBS:
  record <site>             Capture a teaching session for <site>
  assemble <session.jsonl>  Reconstruct session.json from streaming JSONL
                            (recovery if 'record' shutdown didn't finish)
  check <session>           Sanity-check a captured session.json or .jsonl
  redact <session.json>     Scrub credentials + PII; write <session>.redacted.json
                            (always do this before sharing or LLM analysis)
  generate <session.json>   Analyze a session, produce workflow.json
  emit <workflow.json>      Generate the MCP server TS module
  login <site>              Persist auth cookies for <site>
  cron <site>               Start the polling daemon for examples/<site>/cron.json
                            options: --once  --run-now  --config <path>
  mcp-server                Run the MCP server (stdio by default; --http for HTTP)
                            options: --site <name>  --http  --port <num>
  compile-playbook <s.json> Turn a recorded session into a markdown playbook
                            (DOM fallback for sites where API replay is blocked)
                            options: --out <path>
  playbook <site>           Run examples/<site>/playbook.yaml against a real browser
                            options: --headed  --param k=v  --path <path>
  probe-backends <site>     Try each backend (fetch / stealth-fetch / playbook)
                            once and write examples/<site>/backends.json with
                            the ranked order. cron + MCP read this so they
                            don't burn a fetch attempt every tick on bot-
                            protected sites.
                            options: --out <path>  --param k=v

OPTIONS for \`record\`:
  --url <url>               Starting URL (else opens about:blank)
  --out <path>              Output path for session.jsonl
  --persist-profile         Reuse Chrome profile for this site between recordings
                            (preserves login state — useful for repeated captures
                             against an authed site like Discover & Go)

OPTIONS:
  --help, -h                Show this help
  --version, -v             Print version
`;

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

  switch (verb) {
    case 'record': {
      const { record } = await import('./imprint/record.ts');
      const site = argv[1];
      if (!site) {
        console.error('error: `imprint record` requires a <site> argument');
        return 2;
      }
      const { values } = parseArgs({
        args: argv.slice(2),
        options: {
          url: { type: 'string' },
          out: { type: 'string' },
          'persist-profile': { type: 'boolean' },
        },
        allowPositionals: false,
      });

      // Wire SIGINT (Ctrl+C) to a clean shutdown via AbortController instead of
      // tearing the process down mid-flight. The recorder writes its files, then
      // returns; only then does the CLI exit.
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

    case 'assemble': {
      const jsonlPath = argv[1];
      if (!jsonlPath) {
        console.error('error: `imprint assemble` requires a <session.jsonl> argument');
        return 2;
      }
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
      const sessionPath = argv[1];
      if (!sessionPath) {
        console.error(
          'error: `imprint check` requires a <session.json> or <session.jsonl> argument',
        );
        return 2;
      }
      const { checkSession, reportCheck } = await import('./imprint/check.ts');
      const result = checkSession(sessionPath);
      reportCheck(sessionPath, result);
      return result.ok ? 0 : 1;
    }

    case 'redact': {
      const sessionPath = argv[1];
      if (!sessionPath) {
        console.error('error: `imprint redact` requires a <session.json> argument');
        return 2;
      }
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
      const sessionPath = argv[1];
      if (!sessionPath) {
        console.error('error: `imprint generate` requires a <session.json> argument');
        return 2;
      }
      const { values } = parseArgs({
        args: argv.slice(2),
        options: {
          out: { type: 'string' },
          'no-shrink': { type: 'boolean' },
          'save-shrunken': { type: 'boolean' },
        },
        allowPositionals: false,
      });
      const { generate } = await import('./imprint/generate.ts');
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
      const workflowPath = argv[1];
      if (!workflowPath) {
        console.error('error: `imprint emit` requires a <workflow.json> argument');
        return 2;
      }
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
      return 0;
    }

    case 'login': {
      const site = argv[1];
      if (!site) {
        console.error('error: `imprint login` requires a <site> argument');
        return 2;
      }
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
      const site = argv[1];
      if (!site) {
        console.error('error: `imprint cron` requires a <site> argument');
        return 2;
      }
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
      const site = argv[1];
      if (!site) {
        console.error('error: `imprint probe-backends` requires a <site> argument');
        return 2;
      }
      const { values } = parseArgs({
        args: argv.slice(2),
        options: {
          out: { type: 'string' },
          param: { type: 'string', multiple: true },
        },
        allowPositionals: false,
      });
      const overrides: Record<string, string | number | boolean> = {};
      for (const kv of values.param ?? []) {
        const eq = kv.indexOf('=');
        if (eq === -1) {
          console.error(`error: --param requires k=v form, got "${kv}"`);
          return 2;
        }
        const k = kv.slice(0, eq);
        const v = kv.slice(eq + 1);
        if (v === 'true' || v === 'false') overrides[k] = v === 'true';
        else if (v !== '' && !Number.isNaN(Number(v))) overrides[k] = Number(v);
        else overrides[k] = v;
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
      const sessionPath = argv[1];
      if (!sessionPath) {
        console.error('error: `imprint compile-playbook` requires a <session.json> argument');
        return 2;
      }
      const { values } = parseArgs({
        args: argv.slice(2),
        options: { out: { type: 'string' } },
        allowPositionals: false,
      });
      const { compilePlaybook } = await import('./imprint/playbook-compiler.ts');
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
      const site = argv[1];
      if (!site) {
        console.error('error: `imprint playbook` requires a <site> argument');
        return 2;
      }
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
      const params: Record<string, string | number | boolean> = {};
      for (const kv of values.param ?? []) {
        const eq = kv.indexOf('=');
        if (eq === -1) {
          console.error(`error: --param requires k=v form, got "${kv}"`);
          return 2;
        }
        const k = kv.slice(0, eq);
        const v = kv.slice(eq + 1);
        // Best-effort coerce: number if numeric, boolean if true/false, else string
        if (v === 'true' || v === 'false') params[k] = v === 'true';
        else if (v !== '' && !Number.isNaN(Number(v))) params[k] = Number(v);
        else params[k] = v;
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

    default:
      console.error(`error: unknown verb '${verb}'\n`);
      console.log(HELP);
      return 2;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('imprint: fatal:', err instanceof Error ? err.message : String(err));
    if (process.env.IMPRINT_DEBUG) {
      console.error(err);
    }
    process.exit(1);
  });
