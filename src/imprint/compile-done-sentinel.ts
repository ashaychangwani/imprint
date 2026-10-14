import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute as pathIsAbsolute, join as pathJoin } from 'node:path';
import type { CompileVerificationMode, CompileVerificationSummary } from './compile-agent-types.ts';
import { LiveVerificationReportSchema } from './live-verifier.ts';

interface CompileDoneSentinelPayload {
  summary?: unknown;
  verification?: unknown;
  verificationMode?: unknown;
  liveVerified?: unknown;
  liveVerificationOwner?: unknown;
  safetyWaiver?: unknown;
  semanticVerification?: unknown;
  cycles?: unknown;
  failures?: unknown;
}

interface SemanticVerificationFacts {
  status?: unknown;
  completed?: unknown;
  provider?: unknown;
  model?: unknown;
  attempts?: unknown;
  evidenceArtifact?: unknown;
  logArtifact?: unknown;
}

type ParsedCompileDoneSentinel =
  | {
      ok: true;
      message: string;
      verification?: CompileVerificationSummary;
    }
  | {
      ok: false;
      message: string;
    };

function rejected(reason: string): ParsedCompileDoneSentinel {
  return { ok: false, message: `Compile done sentinel was rejected: ${reason}` };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function artifactPath(toolDir: string, artifact: string): string {
  return pathIsAbsolute(artifact) ? artifact : pathJoin(toolDir, artifact);
}

/**
 * Parse the MCP compiler's terminal receipt without inferring missing proof.
 *
 * Both CLI adapters use this one fail-closed boundary. A master MVP must say
 * explicitly that it is a master MVP and that semantic review did not run. A
 * full data compile must carry an explicit approved semantic-review receipt
 * whose durable report and referenced evidence files are present and agree.
 */
export function parseCompileDoneSentinel(
  raw: string,
  opts: {
    toolDir: string;
    expectedMode?: CompileVerificationMode;
    authMode?: boolean;
  },
): ParsedCompileDoneSentinel {
  let payload: CompileDoneSentinelPayload;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return rejected('receipt is not a JSON object');
    }
    payload = parsed as CompileDoneSentinelPayload;
  } catch (error) {
    return rejected(
      `receipt is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const summary = nonEmptyString(payload.summary) ? payload.summary : 'Task completed';
  if (payload.failures !== undefined && !Array.isArray(payload.failures)) {
    return rejected('failures must be an array when present');
  }
  const failures = Array.isArray(payload.failures) ? payload.failures.map(String) : [];
  if (failures.length > 0) {
    return rejected(`receipt contains failures:\n${failures.join('\n')}`);
  }

  if (opts.authMode) {
    if (payload.verification !== 'mechanical_passed') {
      return rejected('auth compile lacks an explicit mechanical_passed receipt');
    }
    return { ok: true, message: summary };
  }

  const expectedMode = opts.expectedMode ?? 'full';
  const semantic =
    payload.semanticVerification &&
    typeof payload.semanticVerification === 'object' &&
    !Array.isArray(payload.semanticVerification)
      ? (payload.semanticVerification as SemanticVerificationFacts)
      : undefined;

  if (payload.verification === 'not_applicable') {
    if (payload.verificationMode !== expectedMode) {
      return rejected(
        `not_applicable receipt mode ${String(payload.verificationMode)} does not match expected ${expectedMode}`,
      );
    }
    if (
      payload.liveVerified !== false ||
      payload.safetyWaiver !== 'irreversible' ||
      semantic?.status !== 'not_applicable'
    ) {
      return rejected(
        'not_applicable receipt must explicitly identify an irreversible workflow and semantic status not_applicable',
      );
    }
    return {
      ok: true,
      message: `${summary} (live verification: N/A)`,
      verification: {
        mode: expectedMode,
        deterministic: 'passed',
        semantic: 'not_applicable',
      },
    };
  }

  if (payload.verification !== 'mechanical_passed') {
    const cycle = typeof payload.cycles === 'number' ? payload.cycles : '?';
    return rejected(`verification did not pass after ${cycle} cycles`);
  }

  if (expectedMode === 'master_mvp') {
    if (
      payload.verificationMode !== 'master_mvp' ||
      payload.liveVerified !== false ||
      semantic?.status !== 'not_run'
    ) {
      return rejected(
        'master_mvp success requires explicit verificationMode=master_mvp, liveVerified=false, and semanticVerification.status=not_run',
      );
    }
    return {
      ok: true,
      message: summary,
      verification: {
        mode: 'master_mvp',
        deterministic: 'passed',
        semantic: 'not_run',
      },
    };
  }

  if (
    payload.verificationMode !== 'full' ||
    payload.liveVerified !== true ||
    semantic?.status !== 'approved' ||
    semantic.completed !== true ||
    !nonEmptyString(semantic.provider) ||
    !nonEmptyString(semantic.model) ||
    !Number.isInteger(semantic.attempts) ||
    (semantic.attempts as number) < 1 ||
    !nonEmptyString(semantic.evidenceArtifact) ||
    !nonEmptyString(semantic.logArtifact)
  ) {
    return rejected(
      'full success requires explicit full mode, liveVerified=true, and completed approved semantic-review facts',
    );
  }

  const reportPath = pathJoin(opts.toolDir, '.live-verification.json');
  if (!existsSync(reportPath)) {
    return rejected('full success is missing .live-verification.json');
  }

  try {
    const report = LiveVerificationReportSchema.parse(JSON.parse(readFileSync(reportPath, 'utf8')));
    if (report.status !== 'approved') {
      return rejected(`semantic report status is ${report.status}, not approved`);
    }
    if (
      report.evidenceArtifact !== semantic.evidenceArtifact ||
      report.logArtifact !== semantic.logArtifact
    ) {
      return rejected('semantic report artifact facts do not match the terminal receipt');
    }
  } catch (error) {
    return rejected(
      `semantic report is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  for (const artifact of [semantic.evidenceArtifact, semantic.logArtifact]) {
    if (!existsSync(artifactPath(opts.toolDir, artifact))) {
      return rejected(`semantic proof artifact is missing: ${artifact}`);
    }
  }

  return {
    ok: true,
    message: summary,
    verification: {
      mode: 'full',
      deterministic: 'passed',
      semantic: 'approved',
      reportPath,
    },
  };
}
