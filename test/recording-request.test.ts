import { describe, expect, test } from 'bun:test';
import { compareRecordedRequest } from '../src/imprint/recording-request.ts';

const recorded = {
  seq: 42,
  method: 'POST',
  url: 'https://example.test/search?q=sea',
  headers: {
    'content-type': 'application/json',
    'x-session': 'private-recorded-value',
  },
  body: JSON.stringify({ query: 'sea', page: 1 }),
};

const workflow = {
  method: 'POST',
  url: 'https://example.test/search?q=${param.query}',
  headers: {
    'content-type': 'application/json',
    'x-session': '${state.session}',
  },
  body: JSON.stringify({ query: '${param.query}', page: 1 }),
};

describe('compareRecordedRequest', () => {
  test('reports an entirely matching templated request', () => {
    const result = compareRecordedRequest(recorded, workflow, { requestIndex: 0 });

    expect(result).toEqual({
      requestIndex: 0,
      recordedSeq: 42,
      matches: true,
      comparisons: {
        headers: { status: 'matched' },
        method: { status: 'matched' },
        originPath: { status: 'matched' },
        url: { status: 'matched' },
        body: { status: 'matched' },
      },
    });
  });

  test('stops after a header mismatch and never includes private values', () => {
    const result = compareRecordedRequest(recorded, {
      ...workflow,
      headers: { ...workflow.headers, 'x-session': 'wrong-value' },
    });

    expect(result.matches).toBe(false);
    expect(result.comparisons.headers).toMatchObject({
      status: 'mismatched',
      field: 'headers.x-session',
    });
    expect(result.comparisons.method.status).toBe('not_checked');
    expect(result.comparisons.body.status).toBe('not_checked');
    expect(JSON.stringify(result)).not.toContain('private-recorded-value');
  });

  test('marks every later comparison as not checked after method failure', () => {
    const result = compareRecordedRequest(recorded, { ...workflow, method: 'GET' });

    expect(result.comparisons.headers.status).toBe('matched');
    expect(result.comparisons.method.status).toBe('mismatched');
    expect(result.comparisons.originPath.status).toBe('not_checked');
    expect(result.comparisons.url.status).toBe('not_checked');
    expect(result.comparisons.body.status).toBe('not_checked');
  });

  test('reports a bounded structural body location without body values', () => {
    const result = compareRecordedRequest(recorded, {
      ...workflow,
      body: JSON.stringify({ query: '${param.query}', page: 2 }),
    });

    expect(result.comparisons.body).toMatchObject({
      status: 'mismatched',
      structuralPath: '$.page',
      workflowType: 'number',
      recordedType: 'number',
    });
    expect(result.comparisons.body.workflowBytes).toBeGreaterThan(0);
    expect(result.comparisons.body.recordedBytes).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('"page":1');
  });

  test('does not pretend transform-owned URL and body checks ran', () => {
    const result = compareRecordedRequest(recorded, workflow, {
      hasRequestTransform: true,
    });

    expect(result.matches).toBe(true);
    expect(result.comparisons.url.status).toBe('not_applicable');
    expect(result.comparisons.body.status).toBe('not_applicable');
  });
});
