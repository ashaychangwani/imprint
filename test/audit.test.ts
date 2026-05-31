import { describe, expect, it } from 'bun:test';
import {
  type AuditReport,
  AuditReportSchema,
  computeAuditScore,
  extractReport,
} from '../src/imprint/audit.ts';

/** Build a report from a flat list of verdicts spread across one tool. */
function reportFromVerdicts(
  verdicts: AuditReport['tools'][number]['invocations'][number]['verdict'][],
): AuditReport {
  return AuditReportSchema.parse({
    tools: [
      {
        name: 'a_tool',
        invocations: verdicts.map((verdict) => ({
          params: {},
          ok: verdict === 'correct',
          verdict,
          reason: '',
        })),
      },
    ],
  });
}

describe('computeAuditScore', () => {
  it('passes when all graded are correct and graded >= 2*toolCount', () => {
    const report = reportFromVerdicts(['correct', 'correct', 'correct', 'correct']);
    const score = computeAuditScore(report, 2, 95);
    expect(score.correct).toBe(4);
    expect(score.broken).toBe(0);
    expect(score.graded).toBe(4);
    expect(score.score).toBe(100);
    expect(score.verdict).toBe('pass');
  });

  it('computes the right percentage and fails below minScore', () => {
    // 3 correct, 1 broken → 75% < 95%.
    const report = reportFromVerdicts(['correct', 'correct', 'correct', 'tool_broken']);
    const score = computeAuditScore(report, 1, 95);
    expect(score.correct).toBe(3);
    expect(score.broken).toBe(1);
    expect(score.graded).toBe(4);
    expect(score.score).toBe(75);
    expect(score.verdict).toBe('fail');
  });

  it('returns inconclusive when nothing is gradeable (all infra)', () => {
    const report = reportFromVerdicts(['infra', 'infra', 'infra']);
    const score = computeAuditScore(report, 1, 95);
    expect(score.graded).toBe(0);
    expect(score.infra).toBe(3);
    expect(score.score).toBe(0);
    expect(score.verdict).toBe('inconclusive');
  });

  it('fails a high score when graded < 2*toolCount (insufficient signal)', () => {
    // 100% but only 1 gradeable invocation against 2 tools (need >= 4).
    const report = reportFromVerdicts(['correct', 'infra', 'bad_params']);
    const score = computeAuditScore(report, 2, 95);
    expect(score.score).toBe(100);
    expect(score.graded).toBe(1);
    expect(score.verdict).toBe('fail');
  });

  it('excludes infra and bad_params from the denominator', () => {
    // 2 correct + 0 broken graded; the infra/bad_params do not dilute the score.
    const report = reportFromVerdicts([
      'correct',
      'correct',
      'infra',
      'infra',
      'bad_params',
      'bad_params',
    ]);
    const score = computeAuditScore(report, 1, 95);
    expect(score.correct).toBe(2);
    expect(score.broken).toBe(0);
    expect(score.infra).toBe(2);
    expect(score.badParams).toBe(2);
    expect(score.graded).toBe(2);
    expect(score.score).toBe(100);
    expect(score.verdict).toBe('pass');
  });

  it('counts verdicts across multiple tools', () => {
    const report = AuditReportSchema.parse({
      tools: [
        {
          name: 'tool_a',
          invocations: [
            { params: {}, ok: true, verdict: 'correct', reason: '' },
            { params: {}, ok: false, verdict: 'tool_broken', reason: '' },
          ],
        },
        {
          name: 'tool_b',
          invocations: [
            { params: {}, ok: true, verdict: 'correct', reason: '' },
            { params: {}, ok: true, verdict: 'correct', reason: '' },
          ],
        },
      ],
    });
    const score = computeAuditScore(report, 2, 95);
    expect(score.correct).toBe(3);
    expect(score.broken).toBe(1);
    expect(score.graded).toBe(4);
    expect(score.score).toBe(75);
    expect(score.verdict).toBe('fail');
  });
});

describe('AuditReportSchema', () => {
  it('parses a valid report and applies defaults for missing fields', () => {
    const parsed = AuditReportSchema.parse({
      tools: [
        {
          name: 'search_x',
          // invocation omits params and reason → defaults apply
          invocations: [{ ok: true, verdict: 'correct' }],
        },
      ],
      // notes omitted → defaults to ''
    });
    expect(parsed.notes).toBe('');
    expect(parsed.tools[0]?.invocations[0]?.params).toEqual({});
    expect(parsed.tools[0]?.invocations[0]?.reason).toBe('');
  });

  it('defaults tools and invocations to empty arrays', () => {
    const parsed = AuditReportSchema.parse({});
    expect(parsed.tools).toEqual([]);
    expect(parsed.notes).toBe('');
  });

  it('rejects an invalid verdict value', () => {
    const result = AuditReportSchema.safeParse({
      tools: [
        {
          name: 'search_x',
          invocations: [{ ok: false, verdict: 'maybe' }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('requires ok and verdict on each invocation', () => {
    const result = AuditReportSchema.safeParse({
      tools: [{ name: 'search_x', invocations: [{ params: {} }] }],
    });
    expect(result.success).toBe(false);
  });
});

describe('extractReport', () => {
  it('recovers the report from a fenced json block', () => {
    const text = `Here is my audit.

\`\`\`json
{ "tools": [{ "name": "t", "invocations": [{ "ok": true, "verdict": "correct" }] }], "notes": "done" }
\`\`\``;
    const report = extractReport(text);
    expect(report?.notes).toBe('done');
    expect(report?.tools[0]?.name).toBe('t');
  });

  it('prefers the last fenced json block', () => {
    const text = `\`\`\`json
{ "tools": [{ "name": "old", "invocations": [] }], "notes": "first" }
\`\`\`

then revised:

\`\`\`json
{ "tools": [{ "name": "new", "invocations": [] }], "notes": "second" }
\`\`\``;
    const report = extractReport(text);
    expect(report?.notes).toBe('second');
    expect(report?.tools[0]?.name).toBe('new');
  });

  it('falls back to a balanced top-level object when unfenced', () => {
    const text =
      'final report: { "tools": [{ "name": "t", "invocations": [{ "ok": false, "verdict": "tool_broken" }] }], "notes": "x" }';
    const report = extractReport(text);
    expect(report?.tools[0]?.invocations[0]?.verdict).toBe('tool_broken');
  });

  it('returns undefined when nothing parses', () => {
    expect(extractReport('no json here at all')).toBeUndefined();
    expect(extractReport('')).toBeUndefined();
  });
});
