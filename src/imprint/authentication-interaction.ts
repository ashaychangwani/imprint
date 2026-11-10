/** Connect agent-selected auth work to the existing live auth compiler. */
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AuthCompileContext, type compileAuthAgent } from './auth-compile-agent.ts';
import { isCredentialReference } from './credential-extract.ts';
import { credentialObservation } from './credential-observation.ts';
import { loadSiteCredentials } from './credential-store.ts';
import type { LLMOptions } from './llm.ts';
import type { RunDeadlineRef } from './provider-retry.ts';
import type { Session } from './types.ts';
import { currentUserInteraction } from './user-interaction.ts';

export function attachRecordedAuthentication(options: {
  session: Session;
  sessionPath: string;
  root: string;
  values: Record<string, string>;
  llmConfig?: LLMOptions;
  runDeadline?: RunDeadlineRef;
  compile?: typeof compileAuthAgent;
  report?: (message: string) => void;
}): void {
  const interaction = currentUserInteraction();
  if (!interaction) return;
  const contexts = new Map<string, { context: AuthCompileContext; outDir: string }>();
  const workspaces = new Set<string>();
  const recordingRevision = randomUUID();
  const refreshMetadata = (contextRef: string, outDir: string): void => {
    const metadata: Parameters<typeof interaction.updateAuthenticationContext>[1] = {
      recordingRef: options.sessionPath,
      recordingRevision,
      workflowPath: join(outDir, 'workflow.json'),
      evidenceRefs: [
        join(outDir, '.auth-evidence-session.json'),
        join(outDir, '.auth-live-discovery.json'),
      ],
    };
    try {
      const stat = statSync(join(outDir, 'workflow.json'));
      metadata.workflowRevision = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      /* No artifact has been written yet. */
    }
    try {
      const attempt: unknown = JSON.parse(
        readFileSync(join(outDir, '.auth-verification-attempt.json'), 'utf8'),
      );
      if (attempt && typeof attempt === 'object') {
        const value = attempt as Record<string, unknown>;
        if (typeof value.action === 'string') metadata.latestAction = value.action;
        if (typeof value.ok === 'boolean') metadata.latestOk = value.ok;
        metadata.latestStatus = typeof value.status === 'number' ? value.status : undefined;
        metadata.latestError = typeof value.error === 'string' ? value.error : undefined;
      }
    } catch {
      /* Discovery need not have a compiled action attempt. */
    }
    interaction.updateAuthenticationContext(contextRef, metadata);
  };
  interaction.addCleanup(async () => {
    await Promise.allSettled(Array.from(contexts.values(), ({ context }) => context.dispose()));
    contexts.clear();
  });
  interaction.setAuthenticate(async (plan, signal) => {
    const knownSeqs = new Set(options.session.requests.map(({ seq }) => seq));
    if (
      [...plan.credentialRequestSeqs, ...plan.authRequestSeqs].some((seq) => !knownSeqs.has(seq))
    ) {
      return {
        status: 'failed',
        message: 'Authentication plan cites a request outside the selected recording.',
      };
    }
    options.report?.(
      `authenticating with ${plan.toolName}; questions appear in the terminal when needed`,
    );
    const compile = options.compile ?? (await import('./auth-compile-agent.ts')).compileAuthAgent;
    // UserInteraction resolves/validates identity before queuing the operation.
    // Its legacy label mapping remains compatible, while explicit refs can cross labels.
    const contextRef = plan.contextRef;
    if (!contextRef) throw new Error('Authentication host requires a resolved contextRef.');
    let retained = contexts.get(contextRef);
    if (!retained) {
      const legacyDir = join(options.root, plan.toolName);
      const outDir = workspaces.has(legacyDir)
        ? join(options.root, `${plan.toolName}-${contextRef}`)
        : legacyDir;
      retained = { context: new AuthCompileContext(), outDir };
      contexts.set(contextRef, retained);
      workspaces.add(outDir);
    }
    const { context, outDir } = retained;
    refreshMetadata(contextRef, outDir);
    if (process.env.IMPRINT_CREDENTIAL_DIAGNOSTICS_PATH) {
      try {
        const stored = await loadSiteCredentials(options.session.site);
        const values = Object.fromEntries(
          Object.entries(options.values).filter(([, value]) => !isCredentialReference(value)),
        );
        const observation = credentialObservation(
          { ...stored, values: { ...stored.values, ...values } },
          'authentication-context-boundary',
        );
        if (observation)
          interaction.updateAuthenticationContext(contextRef, {
            credentialRevision: observation.revision,
          });
      } catch {
        /* Optional context metadata cannot affect authentication. */
      }
    }
    const result = await compile({
      context,
      site: options.session.site,
      session: options.session,
      sessionPath: options.sessionPath,
      outDir,
      authToolPlan: plan,
      teachCredentials: { site: options.session.site, values: options.values },
      llmConfig: options.llmConfig,
      runDeadline: options.runDeadline,
      signal,
      onProgress: (progress) => {
        refreshMetadata(contextRef, outDir);
        options.report?.(`${plan.toolName}: ${progress.toolName ?? progress.phase}`);
      },
    });
    refreshMetadata(contextRef, outDir);
    return {
      contextRef,
      status: result.success ? 'authenticated' : 'failed',
      message: result.message,
      ...(result.workflowPath ? { workflowPath: result.workflowPath } : {}),
    };
  });
}
