/**
 * Tests for the playbook markdown parser. Format spec lives in
 * prompts/playbook-compilation.md; the parser is hand-written and
 * intentionally strict so a malformed playbook fails fast.
 */

import { describe, expect, it } from 'bun:test';
import { parsePlaybook } from '../src/imprint/playbook-parser.ts';

const MIN = `# search_test

## Summary
Test fixture.

## Parameters
- \`q\` (string, required) — query string

## Steps

### Step 1: Open page
- action: navigate
- url: https://example.com/?q=\${q}
- wait_for: networkidle

## Result
- source: xhr
- url_pattern: /api/search
- extract: items[].id
- return_as: hits
`;

describe('parsePlaybook', () => {
  it('parses a minimal valid playbook', () => {
    const p = parsePlaybook(MIN);
    expect(p.toolName).toBe('search_test');
    expect(p.summary).toBe('Test fixture.');
    expect(p.parameters).toHaveLength(1);
    expect(p.parameters[0]).toEqual({
      name: 'q',
      type: 'string',
      description: 'query string',
    });
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0]).toEqual({
      action: 'navigate',
      url: 'https://example.com/?q=${q}',
      wait_for: 'networkidle',
    });
    expect(p.result).toEqual({
      source: 'xhr',
      url_pattern: '/api/search',
      extract: 'items[].id',
      return_as: 'hits',
    });
  });

  it('strips a trailing " playbook" from the H1', () => {
    const md = MIN.replace('# search_test', '# search_test playbook');
    expect(parsePlaybook(md).toolName).toBe('search_test');
  });

  it('rejects an H1 that is not snake_case', () => {
    const md = MIN.replace('# search_test', '# Search Test');
    expect(() => parsePlaybook(md)).toThrow(/snake_case/);
  });

  it('parses parameters with explicit defaults', () => {
    const md = MIN.replace(
      '- `q` (string, required) — query string',
      '- `count` (number) — how many results default: 10',
    );
    const p = parsePlaybook(md);
    expect(p.parameters[0]).toEqual({
      name: 'count',
      type: 'number',
      description: 'how many results',
      default: 10,
    });
  });

  it('parses multi-locator click steps with priority order', () => {
    const md = `# search_test

## Summary
multi-locator fixture

## Parameters
- \`q\` (string, required) — query

## Steps

### Step 1: Open page
- action: navigate
- url: https://example.com
- wait_for: networkidle

### Step 2: Click search
- action: click
- locators:
  - by: role, value: button, name: Search
  - by: text, value: Search
  - by: id, value: search-btn
  - by: css, value: button.search
- wait_for: visible

## Result
- source: xhr
- url_pattern: /api/search
- extract: items[].id
- return_as: hits
`;
    const p = parsePlaybook(md);
    expect(p.steps).toHaveLength(2);
    const step2 = p.steps[1];
    if (step2?.action !== 'click') throw new Error('expected click step');
    expect(step2.locators).toEqual([
      { by: 'role', value: 'button', name: 'Search' },
      { by: 'text', value: 'Search' },
      { by: 'id', value: 'search-btn' },
      { by: 'css', value: 'button.search' },
    ]);
    expect(step2.wait_for).toBe('visible');
  });

  it('parses type steps with value substitution and clear=false', () => {
    const md = `# t

## Summary
x

## Parameters
- \`q\` (string, required) — q

## Steps

### Step 1: Type
- action: type
- locators:
  - by: id, value: input
- value: \${q}

## Result
- source: xhr
- url_pattern: /x
- extract: a
- return_as: r
`;
    const p = parsePlaybook(md);
    const step = p.steps[0];
    if (step?.action !== 'type') throw new Error('expected type step');
    expect(step.value).toBe('${q}');
  });

  it('parses xhr wait_for with a method', () => {
    const md = MIN.replace('- wait_for: networkidle', '- wait_for: xhr:/api/search method:POST');
    const p = parsePlaybook(md);
    expect(p.steps[0]?.wait_for).toEqual({ xhr: '/api/search', method: 'POST' });
  });

  it('parses sleep wait_for', () => {
    const md = MIN.replace('- wait_for: networkidle', '- wait_for: sleep:500');
    const p = parsePlaybook(md);
    expect(p.steps[0]?.wait_for).toEqual({ sleep_ms: 500 });
  });

  it('parses dom-source result blocks', () => {
    const md = MIN.replace(
      `## Result
- source: xhr
- url_pattern: /api/search
- extract: items[].id
- return_as: hits`,
      `## Result
- source: dom
- css: .price
- extract: text
- return_as: prices`,
    );
    const p = parsePlaybook(md);
    expect(p.result.source).toBe('dom');
    if (p.result.source !== 'dom') throw new Error('unreachable');
    expect(p.result.locators).toEqual([{ by: 'css', value: '.price' }]);
    expect(p.result.extract).toBe('text');
  });

  it('rejects a missing ## Steps section', () => {
    const md = MIN.replace(/## Steps[\s\S]*?(?=## Result)/, '');
    expect(() => parsePlaybook(md)).toThrow(/Steps/);
  });

  it('rejects a missing ## Result section', () => {
    const md = MIN.replace(/## Result[\s\S]*$/, '');
    expect(() => parsePlaybook(md)).toThrow(/Result/);
  });

  it('rejects a step missing required action attribute', () => {
    const md = `# t

## Summary
x

## Steps

### Step 1: Bad
- url: https://example.com

## Result
- source: xhr
- url_pattern: /x
- extract: a
- return_as: r
`;
    expect(() => parsePlaybook(md)).toThrow(/missing required attribute "action"/);
  });

  it('rejects a click step with no locators', () => {
    const md = `# t

## Summary
x

## Steps

### Step 1: Click
- action: click
- wait_for: visible

## Result
- source: xhr
- url_pattern: /x
- extract: a
- return_as: r
`;
    expect(() => parsePlaybook(md)).toThrow(/at least one locator/);
  });

  it('preserves the optional notes section', () => {
    const md = `${MIN}
## Notes
must run --headed against this site
`;
    const p = parsePlaybook(md);
    expect(p.notes).toContain('--headed');
  });
});
