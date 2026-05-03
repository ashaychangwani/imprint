/**
 * Markdown ↔ Playbook conversion.
 *
 * Hand-written, no markdown library — the format is deliberately small
 * (H1/H2 sections + H3 steps with a bullet attribute list per step) so
 * a 250-line parser is sufficient. Keeps the Playbook authorable by
 * hand or by an LLM, both of which produce valid markdown.
 *
 * The strict schema lives in playbook-types.ts; this file is the
 * lossy-but-stable text representation.
 */

import { type Locator, type Playbook, PlaybookSchema } from './playbook-types.ts';

/**
 * Parse a playbook markdown document. Throws with a useful message on
 * any structural problem; Zod errors are wrapped so the line context
 * is preserved.
 */
export function parsePlaybook(markdown: string): Playbook {
  const lines = markdown.split('\n');
  const sections = splitSections(lines);

  const toolName = extractToolName(sections.h1);
  const summary = extractSummary(sections.summary);
  const parameters = extractParameters(sections.parameters);
  const steps = extractSteps(sections.steps);
  const result = extractResult(sections.result);
  const notes = sections.notes ? sections.notes.join('\n').trim() || undefined : undefined;

  const candidate = {
    toolName,
    summary,
    parameters,
    steps,
    result,
    notes,
  };

  const parsed = PlaybookSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.errors.map((e) => `  ${e.path.join('.')}: ${e.message}`).join('\n');
    throw new Error(`Playbook failed schema validation:\n${issues}`);
  }
  return parsed.data;
}

interface Sections {
  h1: string;
  summary: string[];
  parameters: string[];
  steps: string[];
  result: string[];
  notes?: string[];
}

function splitSections(lines: string[]): Sections {
  let h1 = '';
  const buckets: Record<string, string[]> = {
    summary: [],
    parameters: [],
    steps: [],
    result: [],
    notes: [],
  };
  let current: keyof typeof buckets | null = null;

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('# ') && !h1) {
      h1 = line.slice(2).trim();
      continue;
    }
    if (line.startsWith('## ')) {
      const heading = line.slice(3).trim().toLowerCase();
      if (heading === 'summary') current = 'summary';
      else if (heading === 'parameters') current = 'parameters';
      else if (heading === 'steps') current = 'steps';
      else if (heading === 'result') current = 'result';
      else if (heading === 'notes') current = 'notes';
      else current = null;
      continue;
    }
    if (current) buckets[current]?.push(line);
  }
  if (!h1) throw new Error('Playbook is missing the required H1 (toolName)');
  const steps = buckets.steps ?? [];
  const result = buckets.result ?? [];
  if (steps.length === 0) {
    throw new Error('Playbook is missing the required ## Steps section');
  }
  if (result.length === 0) {
    throw new Error('Playbook is missing the required ## Result section');
  }
  return {
    h1,
    summary: buckets.summary ?? [],
    parameters: buckets.parameters ?? [],
    steps,
    result,
    notes: buckets.notes && buckets.notes.length > 0 ? buckets.notes : undefined,
  };
}

function extractToolName(h1: string): string {
  // Normalize: `# search_southwest_flights` or `# search_southwest_flights playbook`
  const withoutSuffix = h1.replace(/\s+playbook\s*$/i, '').trim();
  if (!/^[a-z][a-z0-9_]*$/.test(withoutSuffix)) {
    throw new Error(`Playbook H1 must be a snake_case toolName, got "${h1}"`);
  }
  return withoutSuffix;
}

function extractSummary(lines: string[]): string {
  return lines.join('\n').trim() || '(no summary)';
}

function extractParameters(lines: string[]): Playbook['parameters'] {
  const out: Playbook['parameters'] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('- ')) continue;
    // Format: `- \`name\` (type[, required]) — description [default: X]`
    const m = trimmed.match(
      /^-\s+`([a-z][a-z0-9_]*)`\s*\((\w+)(?:,\s*([^)]+))?\)\s*[—-]\s*(.+?)(?:\s+default:\s+(.+))?$/i,
    );
    if (!m) continue;
    const [, name, type, , description, defaultRaw] = m;
    if (!name || !type || !description) continue;
    const param: Playbook['parameters'][number] = {
      name,
      type: type.toLowerCase() as 'string' | 'number' | 'boolean',
      description: description.trim(),
    };
    if (defaultRaw !== undefined) {
      const trimmedDefault = defaultRaw.trim().replace(/^["']|["']$/g, '');
      if (param.type === 'number') param.default = Number(trimmedDefault);
      else if (param.type === 'boolean') param.default = trimmedDefault === 'true';
      else param.default = trimmedDefault;
    }
    out.push(param);
  }
  return out;
}

function extractSteps(lines: string[]): Playbook['steps'] {
  const stepBlocks = splitStepBlocks(lines);
  return stepBlocks.map((block, i) => parseStepBlock(block, i + 1));
}

function splitStepBlocks(lines: string[]): string[][] {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith('### ')) {
      if (current) blocks.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

function parseStepBlock(block: string[], stepNum: number): Playbook['steps'][number] {
  const attrs = extractAttrs(block);
  const action = attrs.action;
  if (!action) {
    throw new Error(`Step ${stepNum} is missing required attribute "action"`);
  }
  switch (action) {
    case 'navigate':
      return {
        action: 'navigate',
        url: requireAttr(attrs, 'url', stepNum),
        wait_for: parseWaitFor(attrs.wait_for),
      };
    case 'click':
      return {
        action: 'click',
        locators: parseLocators(block, stepNum),
        wait_for: parseWaitFor(attrs.wait_for),
      };
    case 'type':
      return {
        action: 'type',
        locators: parseLocators(block, stepNum),
        value: requireAttr(attrs, 'value', stepNum),
        clear: attrs.clear === 'false' ? false : undefined,
        wait_for: parseWaitFor(attrs.wait_for),
      };
    case 'submit':
      return {
        action: 'submit',
        locators: parseLocators(block, stepNum),
        wait_for: parseWaitFor(attrs.wait_for),
      };
    case 'press': {
      const key = requireAttr(attrs, 'key', stepNum);
      const hasLocators = block.some((l) => l.trim().startsWith('- locators:'));
      return {
        action: 'press',
        key,
        locators: hasLocators ? parseLocators(block, stepNum) : undefined,
        wait_for: parseWaitFor(attrs.wait_for),
      };
    }
    case 'wait': {
      const w = parseWaitFor(attrs.wait_for);
      if (!w) throw new Error(`Step ${stepNum} (wait) requires wait_for`);
      return { action: 'wait', wait_for: w };
    }
    default:
      throw new Error(`Step ${stepNum} has unknown action "${action}"`);
  }
}

/**
 * Extract `key: value` bullets from a block. Lines starting with `- ` and
 * containing a single `:` become attributes. Sub-lists (e.g. under
 * `locators:`) are skipped here and parsed separately by parseLocators.
 */
function extractAttrs(block: string[]): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const raw of block) {
    const line = raw.trim();
    if (!line.startsWith('- ')) continue;
    const inner = line.slice(2);
    const colonIdx = inner.indexOf(':');
    if (colonIdx === -1) continue;
    const key = inner.slice(0, colonIdx).trim();
    const value = inner.slice(colonIdx + 1).trim();
    // Skip the "- locators:" header — handled by parseLocators
    if (key === 'locators' && value === '') continue;
    // Skip nested locator entries (they have a leading `  -`, not `-`)
    attrs[key] = value;
  }
  return attrs;
}

function requireAttr(attrs: Record<string, string>, key: string, stepNum: number): string {
  const v = attrs[key];
  if (v === undefined || v === '') {
    throw new Error(`Step ${stepNum} is missing required attribute "${key}"`);
  }
  return v;
}

/**
 * Parse the `locators:` block within a step. Format:
 *   - locators:
 *     - by: text, value: "Book a Flight"
 *     - by: id, value: originationAirportCode
 */
function parseLocators(block: string[], stepNum: number): Locator[] {
  const out: Locator[] = [];
  let inLocators = false;
  for (const raw of block) {
    const line = raw.replace(/\r$/, '');
    const stripped = line.trim();
    if (stripped === '- locators:' || stripped === '-locators:') {
      inLocators = true;
      continue;
    }
    if (!inLocators) continue;
    // Sub-list entry has a leading 2+ spaces then `-`
    const subMatch = line.match(/^\s{2,}-\s+(.+)$/);
    if (!subMatch) {
      // Encountered the next attribute (no leading spaces or only top-level `-`)
      if (stripped.startsWith('- ') && !line.startsWith('  ')) {
        inLocators = false;
      }
      continue;
    }
    const inner = subMatch[1];
    if (!inner) continue;
    out.push(parseLocatorLine(inner, stepNum));
  }
  if (out.length === 0) {
    throw new Error(`Step ${stepNum} (${block[0]?.trim() ?? '?'}) requires at least one locator`);
  }
  return out;
}

function parseLocatorLine(inner: string, stepNum: number): Locator {
  // Format: `by: <kind>, value: <v>` or `by: <kind>, value_pattern: <v>` or
  // `by: role, value: <r>, name: <n>`.
  const parts = splitCommaPairs(inner);
  const map: Record<string, string> = {};
  for (const [k, v] of parts) map[k] = v;
  const by = map.by;
  if (!by) throw new Error(`Step ${stepNum} locator missing "by:": "${inner}"`);
  switch (by) {
    case 'role':
      if (!map.value) throw new Error(`Step ${stepNum} role locator missing "value"`);
      return { by: 'role', value: map.value, name: map.name };
    case 'aria_label':
      return {
        by: 'aria_label',
        value: map.value,
        value_pattern: map.value_pattern,
      };
    case 'text':
      return {
        by: 'text',
        value: map.value,
        value_pattern: map.value_pattern,
      };
    case 'id':
      if (!map.value) throw new Error(`Step ${stepNum} id locator missing "value"`);
      return { by: 'id', value: map.value };
    case 'css':
      if (!map.value) throw new Error(`Step ${stepNum} css locator missing "value"`);
      return { by: 'css', value: map.value };
    default:
      throw new Error(`Step ${stepNum} unknown locator kind "${by}"`);
  }
}

/**
 * Split `key: a, key2: b` into [['key','a'],['key2','b']].
 * Quotes preserve commas inside values.
 */
function splitCommaPairs(s: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  let buf = '';
  let inQuote: string | null = null;
  const fragments: string[] = [];
  for (const ch of s) {
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      else buf += ch;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ',') {
      fragments.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim() !== '') fragments.push(buf);
  for (const frag of fragments) {
    const colonIdx = frag.indexOf(':');
    if (colonIdx === -1) continue;
    const k = frag.slice(0, colonIdx).trim();
    const v = frag
      .slice(colonIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    pairs.push([k, v]);
  }
  return pairs;
}

function parseWaitFor(raw: string | undefined): Playbook['steps'][0]['wait_for'] {
  if (raw === undefined || raw === '') return undefined;
  if (raw === 'networkidle' || raw === 'load' || raw === 'visible' || raw === 'hidden') {
    return raw;
  }
  // xhr:<pattern> or xhr:<pattern> method:<m>
  const xhrMatch = raw.match(/^xhr:\s*([^\s]+)(?:\s+method:\s*(\w+))?$/i);
  if (xhrMatch?.[1]) {
    const out: { xhr: string; method?: string } = { xhr: xhrMatch[1] };
    if (xhrMatch[2]) out.method = xhrMatch[2].toUpperCase();
    return out;
  }
  // sleep:1000
  const sleepMatch = raw.match(/^sleep:\s*(\d+)$/i);
  if (sleepMatch?.[1]) {
    return { sleep_ms: Number(sleepMatch[1]) };
  }
  throw new Error(`Unknown wait_for value: "${raw}"`);
}

function extractResult(lines: string[]): Playbook['result'] {
  const attrs: Record<string, string> = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('- ')) continue;
    const inner = line.slice(2);
    const colonIdx = inner.indexOf(':');
    if (colonIdx === -1) continue;
    const k = inner.slice(0, colonIdx).trim();
    const v = inner
      .slice(colonIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    attrs[k] = v;
  }
  const source = attrs.source;
  if (!source) throw new Error('Result block is missing "source"');
  if (source === 'xhr') {
    if (!attrs.url_pattern) throw new Error('xhr Result missing "url_pattern"');
    if (!attrs.extract) throw new Error('xhr Result missing "extract"');
    const out: Extract<Playbook['result'], { source: 'xhr' }> = {
      source: 'xhr',
      url_pattern: attrs.url_pattern,
      extract: attrs.extract,
      return_as: attrs.return_as ?? 'result',
    };
    if (attrs.method) out.method = attrs.method.toUpperCase();
    return out;
  }
  if (source === 'dom') {
    if (!attrs.extract) throw new Error('dom Result missing "extract"');
    // dom locators are inline single-line for now (one strategy per result).
    const locators: Locator[] = [];
    if (attrs.css) locators.push({ by: 'css', value: attrs.css });
    if (attrs.id) locators.push({ by: 'id', value: attrs.id });
    if (locators.length === 0) {
      throw new Error(
        'dom Result requires at least one locator (e.g. "css: <selector>" or "id: <id>")',
      );
    }
    return {
      source: 'dom',
      locators,
      extract: attrs.extract,
      return_as: attrs.return_as ?? 'result',
    };
  }
  throw new Error(`Unknown Result source "${source}"`);
}
