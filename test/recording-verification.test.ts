import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type RecordingFixture,
  decodeEvidenceResponses,
  parseRecordedResponses,
  verifyRecordingEvidence,
} from '../src/imprint/recording-verification.ts';
import { WorkflowSchema } from '../src/imprint/types.ts';

const operation = {
  name: 'list_items',
  description: 'List items',
  expectedOutput: 'Every item once',
};
const fixtures = (): [RecordingFixture, RecordingFixture] => [
  {
    id: 'recorded',
    origin: 'recording',
    requestSeqs: [1],
    parameters: {},
    responses: [{ items: [{ id: 'old-a' }, { id: 'old-b' }] }],
    actual: { items: [{ id: 'old-a' }, { id: 'old-b' }] },
  },
  {
    id: 'live',
    origin: 'live',
    requestSeqs: [1],
    parameters: {},
    responses: [{ items: [{ id: 'new-a' }] }],
    actual: { items: [{ id: 'new-a' }] },
  },
];
const comparability = { status: 'matched', reason: 'Identical empty request parameters' };
const expectations = [
  {
    sourceId: 'recorded',
    facts: [{ statement: 'Exactly old-a and old-b, each once', quote: 'old-b' }],
  },
  { sourceId: 'live', facts: [{ statement: 'Exactly new-a', quote: 'new-a' }] },
];
describe('recording evidence verification', () => {
  it('keeps unrelated recording/live requests unverified before revealing parser output', async () => {
    let calls = 0;
    const result = await verifyRecordingEvidence({
      operation,
      fixtures: fixtures(),
      directory: mkdtempSync(join(tmpdir(), 'imprint-evidence-test-')),
      agent: { provider: 'codex-cli' },
      requestStep: async (payload, schema) => {
        calls++;
        expect(payload).toHaveProperty('currentDate');
        expect(JSON.stringify(payload)).not.toContain('parser_output');
        return schema.parse({
          action: 'finish',
          expectations,
          reason: 'Bodies are readable',
          comparability: {
            status: 'unverified',
            reason: 'Live request changed a still-valid recorded input',
          },
        });
      },
    });
    expect(result.status).toBe('unverified');
    expect(result.reason).toContain('still-valid');
    expect(calls).toBe(1);
  });

  it('decodes byte-framed Unicode evidence without interpreting its fields', () => {
    const frame = JSON.stringify([['envelope', JSON.stringify({ label: 'Café', rows: [1, 2] })]]);
    const decoded = decodeEvidenceResponses(
      [`)]}'\n\n${Buffer.byteLength(frame)}\n${frame}\n`],
      'decimal-framed-json',
    );
    expect(decoded[0]).toMatchObject({
      index: 0,
      format: 'decimal-framed-json',
      value: [[['envelope', { label: 'Café', rows: [1, 2] }]]],
    });
    expect(decodeEvidenceResponses(['opaque body'])[0]).toHaveProperty('error');
  });

  it('repairs malformed citations without revealing parser output or accepting invalid proof', async () => {
    let turn = 0;
    const result = await verifyRecordingEvidence({
      operation,
      fixtures: fixtures(),
      directory: mkdtempSync(join(tmpdir(), 'imprint-evidence-test-')),
      agent: { provider: 'codex-cli' },
      requestStep: async (payload, schema) => {
        turn++;
        if (turn === 1)
          return schema.parse({
            action: 'finish',
            reason: 'bad citation encoding',
            comparability,
            expectations: expectations.map((e) => ({
              ...e,
              facts: e.facts.map((f) => ({ ...f, quote: 'missing-quote' })),
            })),
          });
        if (turn === 2) {
          expect(payload).toHaveProperty('validationError');
          expect(JSON.stringify(payload)).not.toContain('actual');
          return schema.parse({
            action: 'finish',
            reason: 'Correct exact citations',
            comparability,
            expectations,
          });
        }
        expect(payload).toHaveProperty('expectations', expectations);
        return schema.parse({ action: 'finish', status: 'passed', reason: 'Membership matches' });
      },
    });
    expect(result.status).toBe('passed');
    expect(turn).toBe(3);
  });
  it('freezes independent expectations before revealing output, caches them across a parser repair', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'imprint-evidence-test-'));
    const data = fixtures();
    data[0].actual = { items: [{ id: 'old-a' }] };
    let oracleCalls = 0;
    let evaluationCalls = 0;
    const requestStep: NonNullable<
      Parameters<typeof verifyRecordingEvidence>[0]['requestStep']
    > = async (input, schema) => {
      const payload = input as { phase: string; expectations?: unknown };
      if (payload.phase === 'expectations') {
        oracleCalls++;
        expect(JSON.stringify(input)).not.toContain('actual');
        return schema.parse({
          action: 'finish',
          reason: 'Raw membership established',
          comparability,
          expectations,
        });
      }
      evaluationCalls++;
      expect(payload.expectations).toEqual(expectations);
      return schema.parse({
        action: 'finish',
        status: evaluationCalls === 1 ? 'failed' : 'passed',
        reason:
          evaluationCalls === 1 ? 'Missing old-b' : 'Both source-specific memberships preserved',
      });
    };
    const first = await verifyRecordingEvidence({
      operation,
      fixtures: data,
      directory,
      agent: {},
      requestStep,
    });
    expect(first.status).toBe('failed');
    data[0].actual = fixtures()[0].actual;
    expect(
      (
        await verifyRecordingEvidence({
          operation,
          fixtures: data,
          directory,
          agent: {},
          requestStep,
        })
      ).status,
    ).toBe('passed');
    expect(oracleCalls).toBe(1);
    expect(evaluationCalls).toBe(2);
    expect(JSON.parse(readFileSync(first.reportPath ?? '', 'utf8')).status).toBe('failed');
  });
  it('rejects missing case coverage and fabricated raw citations', async () => {
    for (const invalid of [
      expectations.slice(0, 1),
      [
        {
          ...(expectations[0] as (typeof expectations)[number]),
          facts: [{ statement: 'invented', quote: 'absent-value' }],
        },
        expectations[1] as (typeof expectations)[number],
      ],
    ]) {
      const result = await verifyRecordingEvidence({
        operation,
        fixtures: fixtures(),
        directory: mkdtempSync(join(tmpdir(), 'imprint-evidence-test-')),
        agent: {},
        requestStep: async (_input, schema) =>
          schema.parse({
            action: 'finish',
            comparability,
            expectations: invalid,
            reason: 'claimed coverage',
          }),
      });
      expect(result.status).toBe('unverified');
    }
  });
  it('requires both recording and live response sources', async () => {
    const result = await verifyRecordingEvidence({
      operation,
      fixtures: fixtures().slice(0, 1),
      directory: mkdtempSync(join(tmpdir(), 'imprint-evidence-test-')),
      agent: {},
      requestStep: async () => {
        throw new Error('must not call provider');
      },
    });
    expect(result.status).toBe('unverified');
  });
  it('uses the runtime parser signature and preserves response order', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'imprint-parser-test-'));
    writeFileSync(
      join(directory, 'parser.ts'),
      'export function extract(last, {responses, params}) { return { last, all: responses, query: params.query }; }',
    );
    const workflow = WorkflowSchema.parse({
      site: 'fixture',
      toolName: 'list_items',
      intent: { description: 'Fixture' },
      parameters: [],
      requests: [],
      parserModule: './parser.ts',
    });
    const responses = [{ items: [] }, { items: [{ id: 'a' }] }];
    expect(
      await parseRecordedResponses(join(directory, 'workflow.json'), workflow, responses, {
        query: 'fixture',
      }),
    ).toEqual({ last: responses[1], all: responses, query: 'fixture' });
  });
});

it('projects full raw evidence without depending on a truncated preview', async () => {
  const { projectEvidence } = await import('../src/imprint/recording-verification.ts');
  const rows = Array.from({ length: 500 }, (_, id) => ({ id, text: 'x'.repeat(100) }));
  expect(
    projectEvidence(
      [rows],
      '(responses) => ({count: responses[0].length, last: responses[0].at(-1).id})',
    ),
  ).toBe('{"count":500,"last":499}');
  expect(() => projectEvidence(rows, '() => process.env')).toThrow();
  expect(() => projectEvidence(rows, '() => { while (true) {} }')).toThrow('timed out');
});
