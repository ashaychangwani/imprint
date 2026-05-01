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
  generate <session.json>   Analyze a session, produce workflow.json
  emit <workflow.json>      Generate the MCP server TS module
  login <site>              Persist auth cookies for <site>
  cron <example>            Start the polling daemon
  mcp-server <example>      Run the MCP stdio server

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

    case 'generate':
    case 'emit':
    case 'login':
    case 'cron':
    case 'mcp-server':
      console.error(`error: \`${verb}\` is not implemented yet (coming days 3-7)`);
      return 2;

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
