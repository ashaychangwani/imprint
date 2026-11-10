import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export function recordCompilerHostError(conversationLogPath: string, message: string): void {
  const errorEvent = { type: 'host_error', error: message, timestamp: new Date().toISOString() };
  try {
    const previous = existsSync(conversationLogPath)
      ? JSON.parse(readFileSync(conversationLogPath, 'utf8'))
      : [];
    const log = Array.isArray(previous) ? [...previous, errorEvent] : [previous, errorEvent];
    writeFileSync(conversationLogPath, JSON.stringify(log, null, 2), 'utf8');
  } catch {}
}

/** Error facts for private compiler journals, without exception messages/values. */
export function compilerToolFailure(error: unknown): { name: string; code?: string | number } {
  const value =
    error && typeof error === 'object' ? (error as { name?: unknown; code?: unknown }) : {};
  return {
    name:
      typeof value.name === 'string' && /^[A-Za-z][A-Za-z0-9]*Error$/.test(value.name)
        ? value.name
        : 'Error',
    ...(typeof value.code === 'number' ||
    (typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.code))
      ? { code: value.code }
      : {}),
  };
}
