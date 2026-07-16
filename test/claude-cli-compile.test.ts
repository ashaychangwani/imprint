import { expect, test } from 'bun:test';
import { addCompileUsageTotals } from '../src/imprint/claude-cli-compile.ts';

test('Claude compile usage includes paid safety-filter retries', () => {
  const firstAttempt = {
    turns: 1,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadInputTokens: 75,
    cacheCreationInputTokens: 5,
  };
  const secondAttempt = {
    turns: 2,
    inputTokens: 40,
    outputTokens: 10,
    cacheReadInputTokens: 30,
    cacheCreationInputTokens: 2,
  };

  expect(addCompileUsageTotals(firstAttempt, secondAttempt)).toEqual({
    turns: 3,
    inputTokens: 140,
    outputTokens: 30,
    cacheReadInputTokens: 105,
    cacheCreationInputTokens: 7,
  });
});
