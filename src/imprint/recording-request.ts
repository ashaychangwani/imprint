import type { CapturedRequest, WorkflowRequest } from './types.ts';

const TEMPLATE_PLACEHOLDER = /\$\{[^}]+\}/g;
const EMPTY_REDACTION = /\[REDACTED:v3:id=\d+:len=0\]/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Match a concrete recorded value against a workflow template without
 * interpreting or substituting the dynamic values themselves. */
function templateMatchesRecorded(template: string, recorded: string): boolean {
  // Structured redaction preserves the original length. A sensitive field
  // whose recorded value was empty is therefore still represented by a
  // marker, even though the executable workflow must send the empty string.
  const groundedRecorded = recorded.replace(EMPTY_REDACTION, '');
  if (template === groundedRecorded) return true;
  let cursor = 0;
  let pattern = '^';
  for (const match of template.matchAll(TEMPLATE_PLACEHOLDER)) {
    pattern += escapeRegExp(template.slice(cursor, match.index));
    pattern += '.*?';
    cursor = (match.index ?? 0) + match[0].length;
  }
  if (cursor === 0) return false;
  pattern += `${escapeRegExp(template.slice(cursor))}$`;
  return new RegExp(pattern).test(groundedRecorded);
}

export type RecordedRequestComparisonStatus =
  | 'matched'
  | 'mismatched'
  | 'not_checked'
  | 'not_applicable';

export interface RecordedRequestComparisonFact {
  status: RecordedRequestComparisonStatus;
  reason?: string;
  field?: string;
  workflowBytes?: number;
  recordedBytes?: number;
  firstMismatchByte?: number;
  structuralPath?: string;
  workflowType?: string;
  recordedType?: string;
}

export interface RecordedRequestComparison {
  requestIndex?: number;
  recordedSeq?: number;
  matches: boolean;
  comparisons: {
    headers: RecordedRequestComparisonFact;
    method: RecordedRequestComparisonFact;
    originPath: RecordedRequestComparisonFact;
    url: RecordedRequestComparisonFact;
    body: RecordedRequestComparisonFact;
  };
}

interface StructuralMismatch {
  path: string;
  workflowType: string;
  recordedType: string;
}

function valueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function appendObjectPath(parent: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

function firstStructuralMismatch(
  workflow: unknown,
  recorded: unknown,
  path = '$',
): StructuralMismatch | undefined {
  const workflowType = valueType(workflow);
  const recordedType = valueType(recorded);
  if (workflowType !== recordedType) return { path, workflowType, recordedType };

  if (typeof workflow === 'string' && typeof recorded === 'string') {
    return templateMatchesRecorded(workflow, recorded)
      ? undefined
      : { path, workflowType, recordedType };
  }
  if (
    workflow === null ||
    recorded === null ||
    typeof workflow !== 'object' ||
    typeof recorded !== 'object'
  ) {
    return Object.is(workflow, recorded) ? undefined : { path, workflowType, recordedType };
  }
  if (Array.isArray(workflow) && Array.isArray(recorded)) {
    if (workflow.length !== recorded.length) {
      return {
        path: `${path}.length`,
        workflowType: 'number',
        recordedType: 'number',
      };
    }
    for (let index = 0; index < workflow.length; index++) {
      const mismatch = firstStructuralMismatch(
        workflow[index],
        recorded[index],
        `${path}[${index}]`,
      );
      if (mismatch) return mismatch;
    }
    return undefined;
  }
  if (Array.isArray(workflow) || Array.isArray(recorded)) {
    return { path, workflowType, recordedType };
  }

  const workflowRecord = workflow as Record<string, unknown>;
  const recordedRecord = recorded as Record<string, unknown>;
  const keys = [
    ...new Set([...Object.keys(workflowRecord), ...Object.keys(recordedRecord)]),
  ].sort();
  for (const key of keys) {
    const childPath = appendObjectPath(path, key);
    if (!(key in workflowRecord)) {
      return {
        path: childPath,
        workflowType: 'missing',
        recordedType: valueType(recordedRecord[key]),
      };
    }
    if (!(key in recordedRecord)) {
      return {
        path: childPath,
        workflowType: valueType(workflowRecord[key]),
        recordedType: 'missing',
      };
    }
    const mismatch = firstStructuralMismatch(workflowRecord[key], recordedRecord[key], childPath);
    if (mismatch) return mismatch;
  }
  return undefined;
}

function bodyStructuralMismatch(
  workflowBody: string,
  recordedBody: string,
): StructuralMismatch | undefined {
  try {
    return firstStructuralMismatch(JSON.parse(workflowBody), JSON.parse(recordedBody));
  } catch {
    return undefined;
  }
}

function firstMismatchByte(workflow: string, recorded: string): number {
  const limit = Math.min(workflow.length, recorded.length);
  let index = 0;
  while (index < limit && workflow[index] === recorded[index]) index++;
  return Buffer.byteLength(workflow.slice(0, index), 'utf8');
}

function mismatchFact(
  workflow: string,
  recorded: string,
  extra: Partial<RecordedRequestComparisonFact> = {},
): RecordedRequestComparisonFact {
  return {
    status: 'mismatched',
    workflowBytes: Buffer.byteLength(workflow, 'utf8'),
    recordedBytes: Buffer.byteLength(recorded, 'utf8'),
    firstMismatchByte: firstMismatchByte(workflow, recorded),
    ...extra,
  };
}

function skippedAfter(field: string): RecordedRequestComparisonFact {
  return { status: 'not_checked', reason: `not checked because ${field} mismatched` };
}

function urlWithoutQueryOrHash(value: string): string {
  const query = value.indexOf('?');
  const hash = value.indexOf('#');
  const end = Math.min(query < 0 ? value.length : query, hash < 0 ? value.length : hash);
  return value.slice(0, end);
}

function compareHeaders(
  workflowHeaders: Record<string, string>,
  recordedHeaders: Record<string, string>,
): RecordedRequestComparisonFact {
  const recordedByName = new Map(
    Object.entries(recordedHeaders).map(([name, value]) => [name.toLowerCase(), value]),
  );
  for (const [name, workflowValue] of Object.entries(workflowHeaders).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const recordedValue = recordedByName.get(name.toLowerCase());
    if (recordedValue === undefined) {
      return mismatchFact(workflowValue, '', {
        field: `headers.${name.toLowerCase()}`,
        reason: 'workflow header is absent from the recorded request',
      });
    }
    if (!templateMatchesRecorded(workflowValue, recordedValue)) {
      return mismatchFact(workflowValue, recordedValue, {
        field: `headers.${name.toLowerCase()}`,
      });
    }
  }
  return { status: 'matched' };
}

/**
 * Compare one generated API request with the recorded request that grounds it.
 * The result contains positions, lengths, and structure only—never recorded
 * values. Comparisons stop at the first failure so later fields cannot appear
 * to have passed when they were not examined.
 */
export function compareRecordedRequest(
  recorded: Pick<CapturedRequest, 'seq' | 'method' | 'url' | 'headers' | 'body'>,
  workflow: Pick<WorkflowRequest, 'method' | 'url' | 'headers' | 'body'>,
  opts: { requestIndex?: number; hasRequestTransform?: boolean } = {},
): RecordedRequestComparison {
  const comparisons: RecordedRequestComparison['comparisons'] = {
    headers: compareHeaders(workflow.headers, recorded.headers),
    method: { status: 'not_checked' },
    originPath: { status: 'not_checked' },
    url: { status: 'not_checked' },
    body: { status: 'not_checked' },
  };

  if (comparisons.headers.status === 'mismatched') {
    comparisons.method = skippedAfter('headers');
    comparisons.originPath = skippedAfter('headers');
    comparisons.url = skippedAfter('headers');
    comparisons.body = skippedAfter('headers');
    return {
      requestIndex: opts.requestIndex,
      recordedSeq: recorded.seq,
      matches: false,
      comparisons,
    };
  }

  comparisons.method =
    workflow.method.toUpperCase() === recorded.method.toUpperCase()
      ? { status: 'matched' }
      : mismatchFact(workflow.method.toUpperCase(), recorded.method.toUpperCase());
  if (comparisons.method.status === 'mismatched') {
    comparisons.originPath = skippedAfter('method');
    comparisons.url = skippedAfter('method');
    comparisons.body = skippedAfter('method');
    return {
      requestIndex: opts.requestIndex,
      recordedSeq: recorded.seq,
      matches: false,
      comparisons,
    };
  }

  const workflowOriginPath = urlWithoutQueryOrHash(workflow.url);
  const recordedOriginPath = urlWithoutQueryOrHash(recorded.url);
  comparisons.originPath = templateMatchesRecorded(workflowOriginPath, recordedOriginPath)
    ? { status: 'matched' }
    : mismatchFact(workflowOriginPath, recordedOriginPath);
  if (comparisons.originPath.status === 'mismatched') {
    comparisons.url = skippedAfter('origin/path');
    comparisons.body = skippedAfter('origin/path');
    return {
      requestIndex: opts.requestIndex,
      recordedSeq: recorded.seq,
      matches: false,
      comparisons,
    };
  }

  if (opts.hasRequestTransform) {
    comparisons.url = {
      status: 'not_applicable',
      reason: 'the request transform constructs the final URL',
    };
    comparisons.body = {
      status: 'not_applicable',
      reason: 'the request transform constructs the final body',
    };
  } else {
    comparisons.url = templateMatchesRecorded(workflow.url, recorded.url)
      ? { status: 'matched' }
      : mismatchFact(workflow.url, recorded.url);
    if (comparisons.url.status === 'mismatched') {
      comparisons.body = skippedAfter('URL/query');
      return {
        requestIndex: opts.requestIndex,
        recordedSeq: recorded.seq,
        matches: false,
        comparisons,
      };
    }

    const workflowBody = workflow.body ?? '';
    const recordedBody = recorded.body ?? '';
    if (templateMatchesRecorded(workflowBody, recordedBody)) {
      comparisons.body = { status: 'matched' };
    } else {
      const structural = bodyStructuralMismatch(workflowBody, recordedBody);
      comparisons.body = mismatchFact(workflowBody, recordedBody, {
        ...(structural
          ? {
              structuralPath: structural.path,
              workflowType: structural.workflowType,
              recordedType: structural.recordedType,
            }
          : {}),
      });
    }
  }

  return {
    requestIndex: opts.requestIndex,
    recordedSeq: recorded.seq,
    matches: comparisons.body.status !== 'mismatched',
    comparisons,
  };
}

export function recordedRequestMatchesWorkflow(
  recorded: Pick<CapturedRequest, 'method' | 'url' | 'body'>,
  workflow: Pick<WorkflowRequest, 'method' | 'url' | 'body'>,
): boolean {
  return (
    recorded.method.toUpperCase() === workflow.method.toUpperCase() &&
    templateMatchesRecorded(workflow.url, recorded.url) &&
    (workflow.body === undefined
      ? recorded.body === undefined || recorded.body === ''
      : recorded.body !== undefined && templateMatchesRecorded(workflow.body, recorded.body))
  );
}
