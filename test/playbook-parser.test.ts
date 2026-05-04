/**
 * Tests for the YAML playbook parser. Most edge cases are now handled
 * by the YAML library + Zod — the parser is just a thin glue. These
 * tests cover the glue + a few representative shapes.
 */

import { describe, expect, it } from 'bun:test';
import { parsePlaybook } from '../src/imprint/playbook-parser.ts';

const MIN = `
toolName: search_test
summary: Test fixture
parameters:
  - name: q
    type: string
    description: query
steps:
  - action: navigate
    url: https://example.com/?q=\${q}
    wait_for: networkidle
result:
  source: xhr
  url_pattern: /api/search
  extract: items[].id
  return_as: hits
`;

describe('parsePlaybook (YAML)', () => {
  it('parses a minimal valid playbook', () => {
    const p = parsePlaybook(MIN);
    expect(p.toolName).toBe('search_test');
    expect(p.summary).toBe('Test fixture');
    expect(p.parameters).toHaveLength(1);
    expect(p.parameters[0]).toEqual({
      name: 'q',
      type: 'string',
      description: 'query',
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

  it('parses parameters with defaults of all primitive types', () => {
    const p = parsePlaybook(`
toolName: t
summary: x
parameters:
  - name: count
    type: number
    description: how many
    default: 10
  - name: enabled
    type: boolean
    description: switch
    default: true
  - name: env
    type: string
    description: env name
    default: prod
steps:
  - action: navigate
    url: https://x.com
result:
  source: xhr
  url_pattern: /x
  extract: a
  return_as: r
`);
    expect(p.parameters[0]).toMatchObject({ name: 'count', default: 10 });
    expect(p.parameters[1]).toMatchObject({ name: 'enabled', default: true });
    expect(p.parameters[2]).toMatchObject({ name: 'env', default: 'prod' });
  });

  it('parses multi-locator click step with priority order', () => {
    const p = parsePlaybook(`
toolName: t
summary: x
parameters: []
steps:
  - action: click
    locators:
      - by: role
        value: button
        name: Search
      - by: text
        value: Search
      - by: id
        value: search-btn
      - by: css
        value: button.search
    wait_for: visible
result:
  source: xhr
  url_pattern: /x
  extract: a
  return_as: r
`);
    const step = p.steps[0];
    if (step?.action !== 'click') throw new Error('expected click step');
    expect(step.locators).toHaveLength(4);
    expect(step.locators[0]).toEqual({ by: 'role', value: 'button', name: 'Search' });
    expect(step.locators[3]).toEqual({ by: 'css', value: 'button.search' });
    expect(step.wait_for).toBe('visible');
  });

  it('parses xhr wait_for with optional method', () => {
    const p = parsePlaybook(`
toolName: t
summary: x
parameters: []
steps:
  - action: navigate
    url: https://x.com
    wait_for:
      xhr: /api/search
      method: POST
result:
  source: xhr
  url_pattern: /api/search
  extract: a
  return_as: r
`);
    expect(p.steps[0]?.wait_for).toEqual({ xhr: '/api/search', method: 'POST' });
  });

  it('parses sleep_ms wait_for', () => {
    const p = parsePlaybook(`
toolName: t
summary: x
parameters: []
steps:
  - action: navigate
    url: https://x.com
    wait_for:
      sleep_ms: 500
result:
  source: xhr
  url_pattern: /x
  extract: a
  return_as: r
`);
    expect(p.steps[0]?.wait_for).toEqual({ sleep_ms: 500 });
  });

  it('parses press steps for overlay dismissal', () => {
    const p = parsePlaybook(`
toolName: t
summary: x
parameters: []
steps:
  - action: press
    key: Escape
    wait_for:
      sleep_ms: 300
result:
  source: xhr
  url_pattern: /x
  extract: a
  return_as: r
`);
    const step = p.steps[0];
    if (step?.action !== 'press') throw new Error('expected press step');
    expect(step.key).toBe('Escape');
  });

  it('parses dom-source result blocks', () => {
    const p = parsePlaybook(`
toolName: t
summary: x
parameters: []
steps:
  - action: navigate
    url: https://x.com
result:
  source: dom
  locators:
    - by: css
      value: .price
  extract: text
  return_as: prices
`);
    expect(p.result.source).toBe('dom');
    if (p.result.source !== 'dom') throw new Error('unreachable');
    expect(p.result.locators).toEqual([{ by: 'css', value: '.price' }]);
    expect(p.result.extract).toBe('text');
  });

  it('preserves the optional notes field', () => {
    const p = parsePlaybook(`${MIN}\nnotes: must run --headed against this site\n`);
    expect(p.notes).toContain('--headed');
  });

  it('rejects invalid YAML', () => {
    expect(() => parsePlaybook(': : not valid yaml ::')).toThrow(/YAML/);
  });

  it('rejects schema-invalid documents (missing required field)', () => {
    expect(() =>
      parsePlaybook(`
toolName: t
parameters: []
steps:
  - action: navigate
    url: https://x.com
result:
  source: xhr
  url_pattern: /x
  extract: a
  return_as: r
`),
    ).toThrow(/summary/);
  });

  it('rejects a click step with no locators', () => {
    expect(() =>
      parsePlaybook(`
toolName: t
summary: x
parameters: []
steps:
  - action: click
    wait_for: visible
result:
  source: xhr
  url_pattern: /x
  extract: a
  return_as: r
`),
    ).toThrow(/locators/);
  });
});
