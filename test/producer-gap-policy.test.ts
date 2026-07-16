import { describe, expect, it } from 'bun:test';

async function prompt(name: string): Promise<string> {
  return await Bun.file(new URL(`../prompts/${name}`, import.meta.url)).text();
}

describe('generalized producer-gap policy', () => {
  it('keeps useful producer input classes when an optional consumer token is absent', async () => {
    const compile = await prompt('compile-agent.md');
    const verifier = await prompt('live-verifier-agent.md');
    const planner = await prompt('build-planning.md');

    for (const text of [compile, verifier, planner]) {
      expect(text).toContain('useful producer');
      expect(text).toMatch(/missing|unavailable/);
      expect(text).toMatch(/consumer/);
      expect(text).toMatch(/limitation/);
    }
    expect(compile).toContain('Narrow an input class only when');
    expect(verifier).toContain('Narrow an input class only when');
    expect(planner).toContain("does not redefine the producer's core success");
  });

  it('still rejects wrong core results and forbids fabricated tokens', async () => {
    const compile = await prompt('compile-agent.md');
    const verifier = await prompt('live-verifier-agent.md');

    expect(compile).toContain('Never fabricate');
    expect(compile).toContain("A limitation cannot hide a failure of the tool's core intent");
    expect(verifier).toContain('core result is semantically wrong');
    expect(verifier).toContain('changes_required');
  });
});
