/**
 * Prereq builder for multi-tool `imprint teach`.
 *
 * For each shared module the planner declared (build-plan.ts), this writes
 * `~/.imprint/<site>/_shared/<name>.ts` + a sibling test and verifies it before
 * the per-tool compile fan-out. It runs as a single-shot `llm.analyze` →
 * verify → feedback loop (the same shape compilePlaybook uses), so it works
 * uniformly on every provider (claude-cli, codex-cli, anthropic-api) without a
 * dedicated MCP server. `verifySharedModule` is the deterministic anti-cheat
 * gate: the module must export what the plan declared, its test must pass with
 * non-trivial assertions, it must typecheck, and a kind-specific ground-truth
 * anchor must reproduce the recorded behavior.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname as pathDirname, join as pathJoin } from 'node:path';
import type { SharedModuleSpec } from './build-plan.ts';
import {
  countExpectCalls,
  hasTrivialAssertion,
  runCommand,
  typecheckArtifacts,
} from './compile-tools.ts';
import { type LLMOptions, extractJsonObject, resolveProvider } from './llm.ts';
import { createLog } from './log.ts';
import { looksLikeRpcEnvelope } from './redact.ts';
import { setSpanAttributes, traced } from './tracing.ts';
import type { CapturedRequest, Session } from './types.ts';

const PROMPTS_DIR = pathJoin(import.meta.dir, '..', '..', 'prompts');
const SESSION_PATH_ENV = 'IMPRINT_SESSION_PATH';
const DEFAULT_MAX_CYCLES = 5;
const SOURCE_BODY_LIMIT = 12_000;
const MIN_SIGNING_VALUE_LEN = 8;
const log = createLog('prereq-builder');

let verifyCopyCounter = 0;

/** Import a freshly-written module, defeating bun's stale `.ts` import cache.
 *
 *  Bun keys its transpiled-module cache by file PATH and ignores the `?t=`
 *  query cache-buster for local `.ts` files, so within the long-lived teach
 *  process a re-import after the compile agent edits a module returns the
 *  STALE first-loaded version. That silently breaks per-cycle verification: a
 *  request-transform the agent fixed across cycles still looks like it never
 *  exported `transform`, so a valid signing module fails all cycles and gets
 *  pruned — forcing every tool to re-implement it. (The `bun test` step is
 *  immune because it runs in a fresh subprocess; that's why the test could
 *  pass while the in-process anchor wrongly failed.)
 *
 *  Copying to a unique sibling filename in the SAME directory forces a fresh
 *  load while keeping the module's relative imports to sibling shared modules
 *  resolvable. The leading dot + explicit cleanup keep the temp copy out of
 *  test/typecheck globs. */
export async function importModuleFresh(modulePath: string): Promise<Record<string, unknown>> {
  const uniq = pathJoin(
    pathDirname(modulePath),
    `.verify-${Date.now()}-${process.pid}-${verifyCopyCounter++}.ts`,
  );
  copyFileSync(modulePath, uniq);
  try {
    return (await import(`file://${uniq}`)) as Record<string, unknown>;
  } finally {
    rmSync(uniq, { force: true });
  }
}

// biome-ignore lint/suspicious/noExplicitAny: dynamically-imported user code
type AnyFn = (...args: any[]) => unknown;

interface BuildSharedModuleResult {
  module: SharedModuleSpec;
  ok: boolean;
  failures: string[];
  warnings: string[];
  cycles: number;
  durationMs: number;
}

export async function buildSharedModule(opts: {
  site: string;
  module: SharedModuleSpec;
  session: Session;
  /** Redacted session path — set as IMPRINT_SESSION_PATH when running the test. */
  sessionPath: string;
  sharedDir: string;
  /** Already-built modules this one may depend on (for import context). */
  builtModules?: SharedModuleSpec[];
  llmConfig?: LLMOptions;
  maxCycles?: number;
  onProgress?: (msg: string) => void;
}): Promise<BuildSharedModuleResult> {
  return await traced(
    'teach.build_shared_module',
    'AGENT',
    {
      'imprint.site': opts.session.site,
      'imprint.shared_module': opts.module.path,
      'imprint.shared_module_kind': opts.module.kind,
      'imprint.provider': opts.llmConfig?.provider ?? 'auto',
    },
    async (span) => {
      const start = Date.now();
      const promptPath = pathJoin(PROMPTS_DIR, 'prereq-builder.md');
      if (!existsSync(promptPath)) {
        throw new Error(
          `Prereq-builder prompt not found at ${promptPath}\n→ this is an Imprint installation problem.`,
        );
      }
      const systemPrompt = readFileSync(promptPath, 'utf8');
      const llm = resolveProvider(opts.llmConfig ?? {});
      const maxCycles = opts.maxCycles ?? DEFAULT_MAX_CYCLES;

      // Plan phase (plan-first): one analysis pass that yields a Markdown
      // implementation plan the cycle loop then follows. It grounds the data
      // shape + strict-typing decisions before any code is written, so retries
      // fix mechanics rather than re-deriving structure. Best-effort — a missing
      // prompt or any LLM error degrades to implementing without a plan.
      const plan = await planSharedModule(
        opts.module,
        opts.session,
        opts.builtModules ?? [],
        llm,
        opts.onProgress,
      );
      if (plan) {
        const planFile = `${basename(opts.module.path).replace(/\.ts$/, '')}.plan.md`;
        writeFileSync(pathJoin(opts.sharedDir, planFile), plan, 'utf8');
      }
      setSpanAttributes(span, { 'imprint.shared_module.planned': plan != null });
      const basePayload = buildPrereqPayload(
        opts.module,
        opts.session,
        opts.builtModules ?? [],
        plan,
      );

      let lastFailures: string[] = ['builder produced no output'];
      let lastWarnings: string[] = [];
      let cycle = 0;
      for (cycle = 1; cycle <= maxCycles; cycle++) {
        opts.onProgress?.(
          cycle === 1
            ? `${opts.module.path}: cycle ${cycle}/${maxCycles}`
            : `${opts.module.path}: cycle ${cycle}/${maxCycles} (retrying after: ${summarizeFailures(lastFailures)})`,
        );
        const payload =
          cycle === 1 ? basePayload : { ...basePayload, previousFailures: lastFailures };
        const result = await llm.analyze(systemPrompt, payload);
        const objectText = extractJsonObject(result.text);
        if (!objectText) {
          lastFailures = ['builder did not return a JSON object with {module, test}'];
          continue;
        }
        let parsed: { module?: unknown; test?: unknown };
        try {
          parsed = JSON.parse(objectText);
        } catch (err) {
          lastFailures = [
            `builder returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
          ];
          continue;
        }
        if (typeof parsed.module !== 'string' || parsed.module.trim().length === 0) {
          lastFailures = ['builder response missing a non-empty "module" string'];
          continue;
        }

        writeSharedFiles(
          opts.sharedDir,
          opts.module,
          parsed.module,
          typeof parsed.test === 'string' ? parsed.test : undefined,
        );

        const { failures, warnings } = await verifySharedModule(
          opts.sharedDir,
          opts.module,
          opts.session,
          opts.sessionPath,
        );
        lastFailures = failures;
        lastWarnings = warnings;
        if (failures.length === 0) {
          setSpanAttributes(span, {
            'imprint.shared_module.cycles': cycle,
            'imprint.shared_module.ok': true,
          });
          log(`built ${opts.module.path} in ${cycle} cycle(s)`);
          return {
            module: opts.module,
            ok: true,
            failures: [],
            warnings,
            cycles: cycle,
            durationMs: Date.now() - start,
          };
        }
        log(
          `verify failed for ${opts.module.path} (cycle ${cycle}/${maxCycles}): ${summarizeFailures(failures)}`,
        );
      }

      setSpanAttributes(span, {
        'imprint.shared_module.cycles': maxCycles,
        'imprint.shared_module.ok': false,
      });
      return {
        module: opts.module,
        ok: false,
        failures: lastFailures,
        warnings: lastWarnings,
        cycles: cycle - 1,
        durationMs: Date.now() - start,
      };
    },
  );
}

/** Planning pass (plan-first): one analysis call returning a Markdown
 *  implementation plan the cycle loop then follows. Skipped for type-only
 *  modules and when IMPRINT_NO_PREREQ_PLAN is set. Best-effort — returns
 *  undefined (implement without a plan) on a missing prompt or any LLM error. */
async function planSharedModule(
  module: SharedModuleSpec,
  session: Session,
  builtModules: SharedModuleSpec[],
  llm: ReturnType<typeof resolveProvider>,
  onProgress?: (msg: string) => void,
): Promise<string | undefined> {
  if (module.kind === 'types' || prereqPlanDisabled()) return undefined;
  const promptPath = pathJoin(PROMPTS_DIR, 'prereq-planner.md');
  if (!existsSync(promptPath)) return undefined;
  onProgress?.(`${module.path}: planning`);
  const systemPrompt = readFileSync(promptPath, 'utf8');
  const payload = buildPrereqPayload(module, session, builtModules);
  try {
    const result = await llm.analyze(systemPrompt, payload);
    const plan = stripCodeFences(result.text).trim();
    if (plan.length === 0) return undefined;
    log(`planned ${module.path} (${plan.length} chars)`);
    return plan;
  } catch (err) {
    log(
      `planning failed for ${module.path} (${err instanceof Error ? err.message : String(err)}) — implementing without a plan`,
    );
    return undefined;
  }
}

function prereqPlanDisabled(): boolean {
  const v = process.env.IMPRINT_NO_PREREQ_PLAN;
  return !!v && !['0', 'false', 'no', 'off'].includes(v.toLowerCase());
}

/** Unwrap a response whose entire body is a single Markdown code fence; leave
 *  inline fences (snippets within the plan) untouched. */
function stripCodeFences(text: string): string {
  const t = text.trim();
  const m = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(t);
  return m?.[1] ?? t;
}

/** Compress the verifier's (possibly multi-KB) failure list into a short,
 *  human-scannable summary of WHICH gate(s) failed — used in the per-cycle
 *  progress line and the "verify failed" log so a slow build reveals its blocker
 *  (typecheck vs test vs anchor) instead of a bare "verify failed". The full
 *  failure text still flows to `previousFailures` (the builder's retry feedback)
 *  and the prune log. Kept in sync with the failure strings produced by
 *  verifySharedModule + the build loop. */
export function summarizeFailures(failures: string[]): string {
  const gates = new Set<string>();
  for (const f of failures) gates.add(classifyFailure(f));
  return [...gates].join(', ') || 'unknown';
}

function classifyFailure(f: string): string {
  if (f.includes('failed typecheck')) return 'typecheck';
  if (f.includes('does not export')) return 'missing export';
  if (f.includes('import failed')) return 'import error';
  if (
    /\bbun test\b.*exited/.test(f) ||
    f.includes('expect() calls') ||
    f.includes('trivial tautological') ||
    f.includes('needs a test proving')
  ) {
    return 'test';
  }
  if (f.includes('(request-transform)')) return 'signing anchor';
  if (f.includes('(parser-helper)')) return 'parser anchor';
  if (f.includes('JSON object') || f.includes('invalid JSON') || f.includes('"module" string')) {
    return 'malformed builder output';
  }
  return 'verification';
}

// ─── Verification (anti-cheat gate) ─────────────────────────────────────────

interface VerifySharedModuleResult {
  failures: string[];
  warnings: string[];
}

export async function verifySharedModule(
  sharedDir: string,
  module: SharedModuleSpec,
  session: Session,
  sessionPath: string,
): Promise<VerifySharedModuleResult> {
  const failures: string[] = [];
  const warnings: string[] = [];

  const base = basename(module.path);
  const name = base.replace(/\.ts$/, '');
  const modulePath = pathJoin(sharedDir, base);
  const testBase = `${name}.test.ts`;
  const testPath = pathJoin(sharedDir, testBase);

  if (!existsSync(modulePath)) {
    failures.push(`${module.path} was not written`);
    return { failures, warnings };
  }

  const moduleSrc = readFileSync(modulePath, 'utf8');
  const typesOnly = isTypesOnlyModule(moduleSrc);
  let importOk = true;

  // 1. Runtime import + exported-symbol checks (skipped for type-only modules).
  if (!typesOnly) {
    try {
      const mod = await importModuleFresh(modulePath);
      for (const sig of module.exportSignatures) {
        if (isTypeSignature(sig)) continue;
        const sym = exportedSymbolName(sig);
        if (sym && !(sym in mod)) {
          failures.push(`${module.path} does not export "${sym}" (declared in exportSignatures)`);
        }
      }
    } catch (err) {
      importOk = false;
      failures.push(
        `${module.path} import failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 2. Test quality + run (skipped for type-only modules — no behavior to test).
  if (!typesOnly && !existsSync(testPath)) {
    failures.push(
      `${testBase} was not written — a shared module needs a test proving its behavior against recorded data`,
    );
  } else if (!typesOnly) {
    const testSrc = readFileSync(testPath, 'utf8');
    const expectCount = countExpectCalls(testSrc);
    if (expectCount < 3) {
      failures.push(`${testBase} has only ${expectCount} expect() calls; need ≥3`);
    }
    if (hasTrivialAssertion(testSrc)) {
      failures.push(
        `${testBase} contains trivial tautological assertions — tests must reference real recorded values`,
      );
    }
    const result = await runCommand(`bun test ${testBase}`, sharedDir, 120000, {
      [SESSION_PATH_ENV]: sessionPath,
    });
    const output = JSON.parse(result.result) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };
    if (output.exitCode !== 0) {
      failures.push(
        `bun test ${testBase} exited ${output.exitCode}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
      );
    }
  }

  // 3. Typecheck the module (+ its declared dependency files).
  const includes = [base, ...module.dependsOn.map((d) => basename(d))];
  const tc = await typecheckArtifacts(sharedDir, includes);
  if (tc.exitCode !== 0 || tc.timedOut) {
    failures.push(
      `${module.path} failed typecheck (exit ${tc.exitCode}${tc.timedOut ? ', timed out' : ''})\nstdout:\n${tc.stdout}\nstderr:\n${tc.stderr}`,
    );
  }

  // 4. Kind-specific ground-truth anchor (only when the module imported cleanly).
  if (!typesOnly && importOk) {
    if (module.kind === 'request-transform') {
      const anchor = await anchorRequestTransform(modulePath, module, session);
      if (anchor.failure) failures.push(anchor.failure);
      if (anchor.warning) warnings.push(anchor.warning);
    } else if (module.kind === 'parser-helper') {
      const warn = await anchorParserHelper(modulePath, module, session);
      if (warn) warnings.push(warn);
    }
  }

  return { failures, warnings };
}

/** The recorded request seqs an anchor checks against: the module's declared
 *  sourceSeqs, or all requests when it declared none. */
function resolveSeqs(module: SharedModuleSpec, session: Session): number[] {
  return module.sourceSeqs.length > 0 ? module.sourceSeqs : session.requests.map((r) => r.seq);
}

/** Re-sign a recorded URL and check the module reproduces the signing param.
 *  A throw / non-string / dropped-path result is a hard failure; an inability
 *  to reproduce any recorded param is a warning (the signer may legitimately
 *  fold in a per-call nonce that can't match a recorded value). */
async function anchorRequestTransform(
  modulePath: string,
  module: SharedModuleSpec,
  session: Session,
): Promise<{ failure?: string; warning?: string }> {
  let transform: unknown;
  try {
    const mod = await importModuleFresh(modulePath);
    transform = mod.transform;
  } catch {
    return {}; // import failure already recorded by the caller
  }
  if (typeof transform !== 'function') {
    return {
      failure: `${module.path} (request-transform) must export a transform(method, url, responses, params?) function`,
    };
  }

  const seqs = resolveSeqs(module, session);
  let attempted = false;
  let anyCallSucceeded = false;
  for (const seq of seqs) {
    const req = session.requests.find((r) => r.seq === seq);
    if (!req) continue;
    let recorded: URL;
    try {
      recorded = new URL(req.url);
    } catch {
      continue;
    }
    const highEntropy = [...recorded.searchParams.entries()].filter(
      ([, v]) => v.length >= MIN_SIGNING_VALUE_LEN,
    );
    if (highEntropy.length === 0) continue;
    attempted = true;

    for (const [key, recordedValue] of highEntropy) {
      const stripped = new URL(req.url);
      stripped.searchParams.delete(key);
      let out: unknown;
      try {
        out = (transform as AnyFn)(req.method, stripped.toString(), []);
      } catch {
        continue;
      }
      const outUrl = typeof out === 'string' ? out : (out as { url?: unknown })?.url;
      if (typeof outUrl !== 'string') continue;
      anyCallSucceeded = true;
      let regenerated: string | null;
      try {
        regenerated = new URL(outUrl).searchParams.get(key);
      } catch {
        regenerated = null;
      }
      if (regenerated === recordedValue) return {}; // anchor satisfied
    }
  }

  if (attempted && !anyCallSucceeded) {
    return {
      failure: `${module.path} (request-transform) threw or returned no URL string when re-signing every recorded URL. It must reproduce the site's signing logic (sourceSeqs ${module.sourceSeqs.join(', ') || 'none'}).`,
    };
  }
  if (attempted) {
    return {
      warning: `${module.path} (request-transform) ran but did not reproduce any recorded high-entropy query param. If signing folds in a per-call nonce this is expected; otherwise verify the algorithm against the recorded .js (sourceSeqs ${module.sourceSeqs.join(', ') || 'none'}).`,
    };
  }
  return {};
}

/** Warning-only: confirm a parser-helper produces non-empty output on a
 *  recorded response body. Helpers with non-body signatures legitimately throw
 *  here, so this never fails the build — the per-tool integration tests that
 *  import the helper are the hard gate. */
async function anchorParserHelper(
  modulePath: string,
  module: SharedModuleSpec,
  session: Session,
): Promise<string | null> {
  let mod: Record<string, unknown>;
  try {
    mod = await importModuleFresh(modulePath);
  } catch {
    return null;
  }
  const fns = module.exportSignatures
    .filter((s) => !isTypeSignature(s))
    .map((s) => exportedSymbolName(s))
    .filter((n): n is string => n != null)
    .map((n) => mod[n])
    .filter((f): f is AnyFn => typeof f === 'function');
  if (fns.length === 0) return null;

  const seqs = resolveSeqs(module, session);

  // Fixture-sanity gate (defense-in-depth): if every recorded source body is
  // neither valid JSON nor a recognized RPC envelope, the ground truth itself is
  // unusable — surface that as a distinct, actionable message instead of letting
  // the builder burn cycles "fixing" code that is actually fine. (Part 1's
  // redaction fix is what prevents the common over-redaction poisoning.)
  const candidateBodies = seqs
    .map((seq) => session.requests.find((r) => r.seq === seq)?.response?.body)
    .filter((b): b is string => typeof b === 'string' && b.length > 0);
  if (
    candidateBodies.length > 0 &&
    candidateBodies.every((b) => !isJsonParseable(b) && !looksLikeRpcEnvelope(b))
  ) {
    return `${module.path} (parser-helper): the recorded response body for sourceSeqs ${module.sourceSeqs.join(', ') || 'none'} is not valid JSON nor a recognized RPC envelope — the fixture appears corrupted, not a code error. Re-record the session or inspect the raw body before iterating.`;
  }

  let body: unknown;
  for (const seq of seqs) {
    const raw = session.requests.find((r) => r.seq === seq)?.response?.body;
    if (!raw) continue;
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
    break;
  }
  if (body === undefined) return null;

  for (const fn of fns) {
    try {
      const out = fn(body);
      if (!isEmptyResult(out)) return null; // at least one export produced data
    } catch {
      // helper may take different args — ignore
    }
  }
  return `${module.path} (parser-helper): no export returned non-empty output when applied to a recorded response body. Verify it parses the captured data (sourceSeqs ${module.sourceSeqs.join(', ') || 'none'}).`;
}

// ─── Payload + file writing ─────────────────────────────────────────────────

function buildPrereqPayload(
  module: SharedModuleSpec,
  session: Session,
  builtModules: SharedModuleSpec[],
  implementationPlan?: string,
): Record<string, unknown> {
  const sources = module.sourceSeqs
    .map((seq) => session.requests.find((r) => r.seq === seq))
    .filter((r): r is CapturedRequest => r != null)
    .map((req) => ({
      seq: req.seq,
      method: req.method,
      url: req.url,
      requestHeaders: req.headers,
      requestBody: truncate(req.body, SOURCE_BODY_LIMIT),
      status: req.response?.status,
      mimeType: req.response?.mimeType,
      responseBody: truncate(req.response?.body, SOURCE_BODY_LIMIT),
    }));

  const availableDependencies = builtModules
    .filter((m) => module.dependsOn.includes(m.path))
    .map((m) => ({
      importPath: `./${basename(m.path)}`,
      exportSignatures: m.exportSignatures,
    }));

  const payload: Record<string, unknown> = {
    site: session.site,
    url: session.url,
    module: {
      path: module.path,
      kind: module.kind,
      purpose: module.purpose,
      exportSignatures: module.exportSignatures,
      spec: module.spec,
      dependsOn: module.dependsOn,
    },
    availableDependencies,
    sources,
  };
  if (implementationPlan) payload.implementationPlan = implementationPlan;
  return payload;
}

function writeSharedFiles(
  sharedDir: string,
  module: SharedModuleSpec,
  moduleSrc: string,
  testSrc: string | undefined,
): void {
  mkdirSync(sharedDir, { recursive: true });
  const base = basename(module.path);
  writeFileSync(pathJoin(sharedDir, base), moduleSrc, 'utf8');
  if (testSrc && testSrc.trim().length > 0) {
    writeFileSync(pathJoin(sharedDir, base.replace(/\.ts$/, '.test.ts')), testSrc, 'utf8');
  }
}

// ─── Source-analysis helpers ────────────────────────────────────────────────

function exportedSymbolName(sig: string): string | null {
  const m = sig.match(
    /export\s+(?:async\s+)?(?:function|const|let|var|class|type|interface|enum)\s+([A-Za-z0-9_$]+)/,
  );
  return m?.[1] ?? null;
}

function isTypeSignature(sig: string): boolean {
  return /export\s+(?:type|interface)\b/.test(sig);
}

/** True when the module declares only type/interface exports — no runtime
 *  surface to test or import-check. */
function isTypesOnlyModule(src: string): boolean {
  if (/export\s+(?:async\s+)?(?:function|const|let|var|class|enum|default)\b/.test(src)) {
    return false;
  }
  return /export\s+(?:type|interface)\b/.test(src);
}

function isJsonParseable(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

function isEmptyResult(value: unknown): boolean {
  if (value == null) return true;
  if (value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

function truncate(s: string | undefined, limit: number): string | undefined {
  if (!s) return undefined;
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}…(truncated, original length ${s.length})`;
}
