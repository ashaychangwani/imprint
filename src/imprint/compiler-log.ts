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
