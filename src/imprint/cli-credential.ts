/**
 * `imprint credential ...` — surface for managing the local credential
 * manager: list / get / set / delete, plus encrypted bundle export/import
 * for laptop → remote-agent sharing, plus a one-shot migration from the
 * legacy JSON store.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import * as p from '@clack/prompts';
import { type BundleEnvelope, exportBundle, importBundle } from './credential-bundle.ts';
import {
  getCredentialBackend,
  legacyStorePath,
  listLegacyStoreSites,
  listManifestSites,
  markLegacyStoreMigrated,
  readLegacyStore,
  readSiteManifest,
  removeManifestEntry,
  upsertManifestEntry,
} from './credential-store.ts';

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseSubArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

const CREDENTIAL_HELP = `imprint credential — manage local credential storage

USAGE
  imprint credential list [<site>]
  imprint credential get <site> <name> --reveal
  imprint credential set <site> <name>
  imprint credential delete <site> <name>
  imprint credential export <site> [--out <path>]
  imprint credential import <site> <bundle-path>
  imprint credential migrate

DESCRIPTION
  Credentials live in the OS keychain (when available) or a libsodium-encrypted
  file at ~/.config/imprint/secrets.enc. Skill folders never carry plaintext
  values — only a credentials.manifest.json that lists the names a downstream
  agent (e.g., OpenClaw / Hermes) needs to provision.

  To share a skill with a remote agent:
    1. Ship the skill folder via git or any other channel.
    2. On the agent, either:
       a) Re-enter credentials interactively:
            imprint credential set <site> username
            imprint credential set <site> password
       b) Or import an encrypted bundle from the laptop:
            (laptop)  imprint credential export <site> --out bundle.imprintbundle
            (agent)   imprint credential import <site> bundle.imprintbundle

EXAMPLES
  imprint credential list southwest-seats
  imprint credential set southwest-seats password
  imprint credential export southwest-seats --out /tmp/sw.imprintbundle
`;

export async function runCredentialCommand(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(CREDENTIAL_HELP);
    return 0;
  }

  const sub = argv[0] ?? '';
  const rest = argv.slice(1);

  switch (sub) {
    case 'list':
      return await cmdList(rest);
    case 'get':
      return await cmdGet(rest);
    case 'set':
      return await cmdSet(rest);
    case 'delete':
    case 'rm':
      return await cmdDelete(rest);
    case 'export':
      return await cmdExport(rest);
    case 'import':
      return await cmdImport(rest);
    case 'migrate':
      return await cmdMigrate();
    default:
      console.error(
        `error: unknown subcommand 'credential ${sub}' — run \`imprint credential --help\``,
      );
      return 2;
  }
}

async function cmdList(argv: string[]): Promise<number> {
  const { positionals } = parseSubArgs(argv);
  const site = positionals[0];

  const backend = await getCredentialBackend();

  if (!site) {
    const manifestSites = listManifestSites();
    const backendSites = await backend.listSites();
    const legacy = listLegacyStoreSites();
    const all = Array.from(new Set([...manifestSites, ...backendSites, ...legacy])).sort();
    if (all.length === 0) {
      console.log('No sites have stored credentials yet.');
      return 0;
    }
    console.log(`Stored credentials (backend: ${backend.id}):`);
    for (const s of all) {
      const m = readSiteManifest(s);
      const names = m?.secrets.map((e) => e.name) ?? (await backend.listSecrets(s));
      const cookies = await backend.getCookies(s);
      const legacyTag = legacy.includes(s) ? ' (legacy)' : '';
      console.log(
        `  ${s}${legacyTag} — ${names.length} secret${names.length === 1 ? '' : 's'} (${names.join(', ') || '–'}), ${cookies.length} cookie${cookies.length === 1 ? '' : 's'}`,
      );
    }
    return 0;
  }

  const m = readSiteManifest(site);
  const backendNames = await backend.listSecrets(site);
  const cookies = await backend.getCookies(site);
  const legacyExists = readLegacyStore(site) !== null;

  if (!m && backendNames.length === 0 && cookies.length === 0 && !legacyExists) {
    console.log(`No credentials stored for "${site}".`);
    return 0;
  }

  console.log(`Credentials for "${site}" (backend: ${backend.id}):`);
  if (m) {
    for (const entry of m.secrets) {
      const has = backendNames.includes(entry.name);
      console.log(
        `  ${entry.name} [${entry.kind}]${has ? '' : ' ⚠ missing in backend'}${entry.description ? ` — ${entry.description}` : ''}`,
      );
    }
  } else {
    for (const n of backendNames) console.log(`  ${n}`);
  }
  if (cookies.length > 0) {
    console.log(
      `  cookies: ${cookies.length} stored (${cookies
        .slice(0, 4)
        .map((c) => c.name)
        .join(', ')}${cookies.length > 4 ? '…' : ''})`,
    );
  }
  if (legacyExists) {
    console.log(
      `  ⚠ legacy JSON store at ${legacyStorePath(site)} — run \`imprint credential migrate\` to move into the backend.`,
    );
  }
  return 0;
}

async function cmdGet(argv: string[]): Promise<number> {
  const { positionals, flags } = parseSubArgs(argv);
  const [site, name] = positionals;
  if (!site || !name) {
    console.error('error: usage: imprint credential get <site> <name> --reveal');
    return 2;
  }
  if (flags.reveal !== true) {
    console.error(
      'error: `imprint credential get` requires --reveal to print the value.\n  This is a guardrail against accidental disclosure (shoulder-surfing, screenshots, logs).',
    );
    return 2;
  }
  const backend = await getCredentialBackend();
  const v = await backend.getSecret(site, name);
  if (v === null) {
    console.error(`error: no secret "${name}" stored for site "${site}".`);
    return 1;
  }
  process.stdout.write(v);
  process.stdout.write('\n');
  return 0;
}

async function cmdSet(argv: string[]): Promise<number> {
  const { positionals } = parseSubArgs(argv);
  const [site, name] = positionals;
  if (!site || !name) {
    console.error('error: usage: imprint credential set <site> <name>');
    return 2;
  }

  const value = await p.password({
    message: `Value for ${site}/${name}`,
    mask: '*',
    validate: (v) => (!v || v.length === 0 ? 'Cannot be empty.' : undefined),
  });
  if (p.isCancel(value)) {
    p.outro('Cancelled.');
    return 0;
  }

  const backend = await getCredentialBackend();
  await backend.setSecret(site, name, value as string);

  // Update the manifest so `list` and downstream consumers see this entry.
  const existing = readSiteManifest(site);
  const existingEntry = existing?.secrets.find((s) => s.name === name);
  upsertManifestEntry(site, {
    name,
    kind: existingEntry?.kind ?? guessKind(name),
    description: existingEntry?.description,
  });

  console.log(`[imprint] saved ${site}/${name} (backend: ${backend.id})`);
  return 0;
}

function guessKind(name: string): 'username' | 'password' | 'email' | 'token' | 'opaque' {
  const n = name.toLowerCase();
  if (n.includes('password') || n.includes('passwd') || n === 'pwd') return 'password';
  if (n.includes('email')) return 'email';
  if (n.includes('user') || n === 'login' || n.includes('account')) return 'username';
  if (n.includes('token') || n.includes('apikey') || n.includes('api_key')) return 'token';
  return 'opaque';
}

async function cmdDelete(argv: string[]): Promise<number> {
  const { positionals } = parseSubArgs(argv);
  const [site, name] = positionals;
  if (!site || !name) {
    console.error('error: usage: imprint credential delete <site> <name>');
    return 2;
  }
  const backend = await getCredentialBackend();
  await backend.deleteSecret(site, name);
  removeManifestEntry(site, name);
  console.log(`[imprint] deleted ${site}/${name}`);
  return 0;
}

async function cmdExport(argv: string[]): Promise<number> {
  const { positionals, flags } = parseSubArgs(argv);
  const site = positionals[0];
  if (!site) {
    console.error('error: usage: imprint credential export <site> [--out <path>]');
    return 2;
  }

  const passphrase = await p.password({
    message: 'Passphrase to encrypt the bundle (≥ 8 chars)',
    mask: '*',
    validate: (v) => (!v || v.length < 8 ? 'Passphrase must be at least 8 characters.' : undefined),
  });
  if (p.isCancel(passphrase)) {
    p.outro('Cancelled.');
    return 0;
  }
  const confirm = await p.password({
    message: 'Confirm passphrase',
    mask: '*',
  });
  if (p.isCancel(confirm)) {
    p.outro('Cancelled.');
    return 0;
  }
  if (confirm !== passphrase) {
    console.error('error: passphrases do not match.');
    return 1;
  }

  const backend = await getCredentialBackend();
  const envelope = await exportBundle({
    backend,
    site,
    passphrase: passphrase as string,
  });

  const outPath = (flags.out as string) ?? `${site}.imprintbundle`;
  writeFileSync(outPath, JSON.stringify(envelope, null, 2), 'utf8');
  console.log(`[imprint] bundle → ${outPath}`);
  console.log(
    `[imprint] transfer this file to the consuming agent (any channel — it's encrypted), then run:`,
  );
  console.log(`           imprint credential import ${site} ${outPath}`);
  return 0;
}

async function cmdImport(argv: string[]): Promise<number> {
  const { positionals } = parseSubArgs(argv);
  const [site, bundlePath] = positionals;
  if (!site || !bundlePath) {
    console.error('error: usage: imprint credential import <site> <bundle-path>');
    return 2;
  }

  let envelope: BundleEnvelope;
  try {
    envelope = JSON.parse(readFileSync(bundlePath, 'utf8')) as BundleEnvelope;
  } catch (err) {
    console.error(
      `error: cannot read bundle "${bundlePath}": ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  if (envelope.site !== site) {
    console.error(
      `error: bundle is for site "${envelope.site}" but you specified "${site}". Re-run with the correct site, or rename via \`imprint credential import ${envelope.site} …\`.`,
    );
    return 1;
  }

  const passphrase = await p.password({
    message: 'Bundle passphrase',
    mask: '*',
  });
  if (p.isCancel(passphrase)) {
    p.outro('Cancelled.');
    return 0;
  }

  const backend = await getCredentialBackend();
  let result: { imported: string[]; cookieCount: number; storageCount: number };
  try {
    result = await importBundle({
      backend,
      envelope,
      passphrase: passphrase as string,
    });
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  console.log(
    `[imprint] imported ${result.imported.length} secret(s) (${result.imported.join(', ') || '–'}), ${result.cookieCount} cookie(s), and ${result.storageCount} storage value(s) for "${site}"`,
  );
  return 0;
}

async function cmdMigrate(): Promise<number> {
  const sites = listLegacyStoreSites();
  if (sites.length === 0) {
    console.log('Nothing to migrate — no legacy ~/.config/imprint/credentials/*.json files found.');
    return 0;
  }
  const backend = await getCredentialBackend();
  console.log(`Migrating ${sites.length} site(s) to backend: ${backend.id}`);
  for (const site of sites) {
    const legacy = readLegacyStore(site);
    if (!legacy) continue;
    let count = 0;
    for (const [name, value] of Object.entries(legacy.values)) {
      await backend.setSecret(site, name, value);
      upsertManifestEntry(site, {
        name,
        kind: guessKind(name),
        description: 'Migrated from legacy JSON store',
      });
      count++;
    }
    if (legacy.cookies.length > 0) {
      await backend.setCookies(site, legacy.cookies);
    }
    markLegacyStoreMigrated(site);
    console.log(
      `  ${site}: ${count} secret${count === 1 ? '' : 's'}, ${legacy.cookies.length} cookie${legacy.cookies.length === 1 ? '' : 's'}`,
    );
  }
  return 0;
}
