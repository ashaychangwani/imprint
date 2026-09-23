import { describe, expect, it } from 'bun:test';
import type { ContentAddressedRef } from '../src/imprint/master-teach-plan.ts';
import { SharedResearchExchangeSchema } from '../src/imprint/teach-research-memory.ts';

import { memoryFixture } from './fixtures/teach-research-memory.ts';

const finding = (
  ref: ContentAddressedRef,
  conclusion = 'Fixture endpoint has two response frames',
) => ({
  applicability: 'Recorded catalog list requests',
  conclusion,
  limitations: 'Detail operations remain untested',
  evidenceRefs: [ref],
});

describe('run-local shared research', () => {
  it('retains concurrent publications, corrections and contradictions without replacing history', async () => {
    const memory = memoryFixture();
    const source = memory.remember({ raw: 'fixture body' });
    const publications = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        Promise.resolve().then(() =>
          memory.exchange(`researcher-${index}`, {
            runId: memory.runId,
            publish: [finding(source, `Discovery ${index}`)],
          }),
        ),
      ),
    );
    expect(memory.list().entries).toHaveLength(10);
    const first = publications[0]?.published[0];
    if (!first) throw new Error('Missing fixture publication');
    memory.exchange('corrector', {
      runId: memory.runId,
      publish: [
        { ...finding(source, 'Corrected finding'), supersedes: [first], contradicts: [first] },
      ],
    });
    expect(memory.list().entries).toHaveLength(11);
    expect(memory.list().entries[0]?.summary).toBe('Discovery 0');
    expect(memory.list().entries[10]?.supersedes).toEqual([first]);
    const read = memory.exchange('reader', {
      runId: memory.runId,
      query: { action: 'read', ref: first, offset: 0, length: 2_000 },
    });
    expect(JSON.stringify(read)).toContain('researcher-0');
    expect(JSON.stringify(read)).toContain('Detail operations remain untested');
  });

  it('bounds reads and index pages, and rejects foreign or unavailable references', () => {
    const memory = memoryFixture();
    const other = memoryFixture('another-run');
    const source = memory.remember({ text: 'x'.repeat(5_000) });
    const foreign = other.remember({ text: 'foreign' });
    for (let index = 0; index < 20; index++)
      memory.exchange('author', {
        runId: memory.runId,
        publish: [finding(source, `Discovery ${index}`)],
      });
    expect(memory.list().entries).toHaveLength(16);
    expect(memory.list().hasMore).toBeTrue();
    expect(memory.list(16).entries).toHaveLength(4);
    expect(memory.delivery('reader', true).entries).toHaveLength(16);
    expect(memory.delivery('reader', true).entries).toHaveLength(4);
    expect(memory.delivery('reader', true).entries).toHaveLength(0);
    const read = memory.exchange('reader', {
      runId: memory.runId,
      query: { action: 'read', ref: source, offset: 0, length: 20 },
    });
    expect(read.read).toMatchObject({ nextOffset: 20 });
    expect(() =>
      memory.exchange('reader', { runId: other.runId, query: { action: 'list', after: 0 } }),
    ).toThrow('another run');
    expect(() =>
      memory.exchange('reader', {
        runId: memory.runId,
        query: { action: 'read', ref: foreign, offset: 0, length: 20 },
      }),
    ).toThrow('not registered');
    expect(() =>
      memory.exchange('reader', {
        runId: memory.runId,
        query: { action: 'read', ref: source, offset: 50_000, length: 20 },
      }),
    ).toThrow('exceeds');
    expect(() =>
      memory.exchange('author', {
        runId: memory.runId,
        publish: [{ ...finding(source), supersedes: [foreign] }],
      }),
    ).toThrow('this run');
    expect(() =>
      SharedResearchExchangeSchema.parse({
        runId: memory.runId,
        query: { action: 'read', ref: source, length: 2_001 },
      }),
    ).toThrow();
  });

  it('delivers a short index and reads a detailed method only by its asset reference', () => {
    const memory = memoryFixture();
    const source = memory.remember({ result: 'fixture response' });
    const method = 'Decode the fixture response by reading each framed record. '.repeat(120);
    memory.exchange('researcher', {
      runId: memory.runId,
      publish: [
        {
          ...finding(source, 'Framed response contains a useful record'),
          applicability: 'fixture response with length framing',
          limitations: 'Other framing remains untested',
          asset: method,
        },
      ],
    });
    const entry = memory.delivery('consumer', true).entries[0];
    expect(entry?.summary).toBe('Framed response contains a useful record');
    expect(JSON.stringify(entry)).not.toContain('Decode the fixture response');
    expect(JSON.stringify(entry)).not.toContain('Other framing remains untested');
    if (!entry?.assetRef) throw new Error('Detailed asset was not published');
    const excerpt = memory.exchange('consumer', {
      runId: memory.runId,
      query: { action: 'read', ref: entry.assetRef, offset: 0, length: 100 },
    });
    expect(JSON.stringify(excerpt.read)).toContain('Decode the fixture response');
    expect((excerpt.read as { nextOffset: number | null }).nextOffset).toBe(100);
    expect(memory.delivery('consumer', true).entries).toHaveLength(0);
  });
});
