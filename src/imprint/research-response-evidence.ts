import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BackendResponseEvidence } from './backend-ladder.ts';
import type { RetainedResponseEvidence } from './master-teach-agent-contracts.ts';

export function retainedResponseEvidencePath(
  toolDir: string,
  observationId: string,
  ref: string,
): string {
  const stem = createHash('sha256')
    .update(JSON.stringify([observationId, ref]))
    .digest('hex');
  return join(toolDir, 'live-results', `${stem}.response.txt`);
}

/** Synchronous writes happen inside the response callback, before downstream
 * execution can fail. The journal also survives cancellation before a research
 * observation is finalized. It is private evidence, never proof of success. */
export function retainResponseEvidence(
  toolDir: string,
  observationId: string,
  candidateSha256: string,
  evidence: BackendResponseEvidence,
): RetainedResponseEvidence {
  mkdirSync(join(toolDir, 'live-results'), { recursive: true });
  const { bodyText, ...metadata } = evidence;
  const reference: RetainedResponseEvidence = {
    ...metadata,
    evidenceRef: randomUUID(),
    ...(bodyText === undefined ? {} : { textLength: bodyText.length }),
  };
  if (bodyText !== undefined)
    writeFileSync(
      retainedResponseEvidencePath(toolDir, observationId, reference.evidenceRef),
      bodyText,
      { encoding: 'utf8', flag: 'wx' },
    );
  appendFileSync(
    join(toolDir, 'live-results', 'responses.jsonl'),
    `${JSON.stringify({ observationId, candidateSha256, ...reference })}\n`,
  );
  return reference;
}
