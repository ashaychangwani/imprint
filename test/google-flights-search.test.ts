import { describe, expect, it } from 'bun:test';
import { extract as extractSearch } from '../examples/google-flights/search_flights/parser.ts';

function batchExecuteFrame(rpcid: string, payload: unknown): string {
  return `)]}'\n\n${JSON.stringify([['wrb.fr', rpcid, JSON.stringify(payload)]])}\n`;
}

describe('Google Flights search parser', () => {
  it('rejects non-batchexecute provider responses instead of returning false zeroes', () => {
    expect(() => extractSearch('<html>temporarily unavailable</html>')).toThrow(
      /GetShoppingResults/,
    );
  });

  it('rejects unrecognized shopping payloads instead of returning false zeroes', () => {
    const raw = batchExecuteFrame('GetShoppingResults', []);
    expect(() => extractSearch(raw)).toThrow(/recognizable itineraries/);
  });
});
