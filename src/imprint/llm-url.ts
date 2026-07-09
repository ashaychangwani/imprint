/**
 * URL compaction for LLM-facing payloads.
 *
 * Runtime code keeps raw URLs. Prompt payloads only need path/query structure
 * and short human-readable values; opaque JWTs and encrypted query params can
 * otherwise dominate the context.
 */

const DEFAULT_MAX_PARAM_VALUE_CHARS = 96;
const DEFAULT_MAX_URL_CHARS = 900;
const DEFAULT_MAX_PARAMS = 40;

export function compactUrlForLlm(
  raw: string,
  opts: {
    maxParamValueChars?: number;
    maxUrlChars?: number;
    maxParams?: number;
  } = {},
): string {
  const maxParamValueChars = opts.maxParamValueChars ?? DEFAULT_MAX_PARAM_VALUE_CHARS;
  const maxUrlChars = opts.maxUrlChars ?? DEFAULT_MAX_URL_CHARS;
  const maxParams = opts.maxParams ?? DEFAULT_MAX_PARAMS;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return truncateMiddle(raw, maxUrlChars);
  }

  const out = new URL(`${url.protocol}//${url.host}${url.pathname}`);
  const totalParams = [...url.searchParams.keys()].length;
  let index = 0;
  for (const [key, value] of url.searchParams.entries()) {
    index++;
    if (index > maxParams) {
      out.searchParams.append('[truncated_params]', String(totalParams - maxParams));
      break;
    }
    out.searchParams.append(key, compactQueryValue(key, value, maxParamValueChars));
  }
  out.hash = url.hash ? '#[hash omitted]' : '';

  return truncateMiddle(out.toString(), maxUrlChars);
}

function compactQueryValue(key: string, value: string, maxChars: number): string {
  if (value.length <= maxChars && !looksOpaqueQueryValue(key, value)) return value;
  const visible = value.length > 0 ? `${value.slice(0, Math.min(16, maxChars))}...` : '';
  return `[truncated:${key} ${visible}len=${value.length}]`;
}

function looksOpaqueQueryValue(key: string, value: string): boolean {
  if (value.length > 160) return true;
  if (/token|jwt|assertion|signature|sig|session|auth|credential|secret/i.test(key)) {
    return value.length > 32;
  }
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(value)) return true;
  const punctuation = (value.match(/[._~-]/g) ?? []).length;
  return value.length > 80 && punctuation >= 4;
}

function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const head = Math.max(1, Math.floor((maxChars - 32) / 2));
  const tail = Math.max(1, maxChars - 32 - head);
  return `${value.slice(0, head)}...[truncated url len=${value.length}]...${value.slice(-tail)}`;
}
