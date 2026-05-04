/**
 * Tests for `imprint doctor`. The actual environment checks read live
 * state (env vars, filesystem) so we keep these focused on the report
 * shape + the rendering of pass/fail/optional results — that's what
 * users see and what's most likely to regress on cosmetic edits.
 */

import { describe, expect, it } from 'bun:test';
import { type CheckResult, doctor, reportDoctor } from '../src/imprint/doctor.ts';

describe('doctor()', () => {
  it('returns one CheckResult per check (currently 9)', () => {
    const checks = doctor();
    expect(checks.length).toBe(9);
    for (const c of checks) {
      expect(typeof c.name).toBe('string');
      expect(typeof c.ok).toBe('boolean');
      expect(typeof c.detail).toBe('string');
    }
  });

  it('always passes the Bun runtime check (we run under Bun)', () => {
    const bun = doctor().find((c) => c.name === 'Bun runtime');
    expect(bun?.ok).toBe(true);
    expect(bun?.detail).toMatch(/^v\d+\.\d+\.\d+/);
  });
});

describe('reportDoctor()', () => {
  const fixtures: CheckResult[] = [
    { name: 'A', ok: true, detail: 'fine' },
    { name: 'B', ok: false, detail: 'broken', fix: 'do the thing' },
    { name: 'C', ok: true, detail: 'optional missing', fix: 'set X' },
  ];

  it('renders pass/fail marks + fixes', () => {
    const r = reportDoctor(fixtures);
    const text = r.lines.join('\n');
    expect(text).toContain('✓ A');
    expect(text).toContain('✗ B');
    expect(text).toContain('→ do the thing');
    expect(text).toContain('hint: set X');
  });

  it('returns ok=false when any required check fails', () => {
    expect(reportDoctor(fixtures).ok).toBe(false);
  });

  it('returns ok=true when all required checks pass (optional advisories ignored)', () => {
    const allPass: CheckResult[] = [
      { name: 'A', ok: true, detail: 'fine' },
      { name: 'B', ok: true, detail: 'optional', fix: 'set Y if you want' },
    ];
    expect(reportDoctor(allPass).ok).toBe(true);
  });

  it('shows a friendly final line in both states', () => {
    expect(reportDoctor(fixtures).lines.at(-1)).toContain('failed');
    expect(reportDoctor([{ name: 'X', ok: true, detail: 'ok' }]).lines.at(-1)).toContain('passed');
  });

  it('header line embeds the imprint version', () => {
    const r = reportDoctor([{ name: 'X', ok: true, detail: 'ok' }]);
    expect(r.lines[0]).toMatch(/imprint v\d+\.\d+\.\d+ doctor/);
  });
});

describe('AI tool advisory checks', () => {
  it('claude code check is always ok (advisory)', () => {
    const checks = doctor();
    const ccCheck = checks.find((c) => c.name === 'Claude Code');
    expect(ccCheck).toBeDefined();
    expect(ccCheck?.ok).toBe(true);
  });

  it('hermes check is always ok (advisory)', () => {
    const checks = doctor();
    const hCheck = checks.find((c) => c.name === 'Hermes Agent');
    expect(hCheck).toBeDefined();
    expect(hCheck?.ok).toBe(true);
  });

  it('openclaw check is always ok (advisory)', () => {
    const checks = doctor();
    const ocCheck = checks.find((c) => c.name === 'OpenClaw');
    expect(ocCheck).toBeDefined();
    expect(ocCheck?.ok).toBe(true);
  });
});
