import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { abortableDelay } from './concurrency.ts';

interface Ticket {
  pid: number;
  started: string | null;
  nonce: string;
  /** null means the contender is still choosing its ticket number. */
  ticket: number | null;
}

function processStart(pid: number): string | null {
  if (process.platform === 'win32') return null;
  try {
    return (
      execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2_000,
      }).trim() || null
    );
  } catch {
    return null;
  }
}

const ownStart = processStart(process.pid);

function ownerIsGone(owner: Ticket): boolean {
  if (owner.pid === process.pid)
    return owner.started !== null && ownStart !== null && owner.started !== ownStart;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
  if (!owner.started) return false;
  const currentStart = processStart(owner.pid);
  return currentStart !== null && currentStart !== owner.started;
}

function removeOwned(path: string, nonce: string): void {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Ticket;
    if (value.nonce === nonce) unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function readTickets(directory: string): Ticket[] {
  const tickets: Ticket[] = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.json')) continue;
    const path = join(directory, name);
    let owner: Ticket;
    try {
      owner = JSON.parse(readFileSync(path, 'utf8')) as Ticket;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      !(owner.started === null || typeof owner.started === 'string') ||
      name !== `${owner.nonce}.json` ||
      !(owner.ticket === null || (Number.isSafeInteger(owner.ticket) && owner.ticket > 0))
    ) {
      throw new Error('Invalid credential lock owner metadata');
    }
    if (ownerIsGone(owner)) {
      // Each owner has a unique path. Recovering this dead owner cannot delete
      // a replacement owner's lock, even when several processes notice it.
      removeOwned(path, owner.nonce);
    } else tickets.push(owner);
  }
  return tickets;
}

/** A cross-process mutex for one durable credential namespace. Unique ticket
 * paths avoid stale-owner cleanup racing a new lock holder. There is no lease
 * timeout: a live owner keeps the lock until it finishes or is cancelled. */
export async function withCredentialLock<T>(
  directory: string,
  signal: AbortSignal | undefined,
  work: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const nonce = randomUUID();
  const path = join(directory, `${nonce}.json`);
  const temporary = join(directory, `${nonce}.tmp`);
  const owner: Ticket = { pid: process.pid, started: ownStart, nonce, ticket: null };
  const publish = () => {
    writeFileSync(temporary, JSON.stringify(owner), { mode: 0o600 });
    renameSync(temporary, path);
  };
  let result: T | undefined;
  let failure: { error: unknown } | undefined;
  try {
    publish();
    const tickets = readTickets(directory);
    owner.ticket = Math.max(0, ...tickets.map(({ ticket }) => ticket ?? 0)) + 1;
    publish();
    while (true) {
      signal?.throwIfAborted();
      const ahead = readTickets(directory).some(
        (other) =>
          other.nonce !== nonce &&
          (other.ticket === null ||
            other.ticket < (owner.ticket ?? 0) ||
            (other.ticket === owner.ticket && other.nonce < nonce)),
      );
      if (!ahead) break;
      await abortableDelay(20, signal);
    }
    signal?.throwIfAborted();
    result = await work();
  } catch (error) {
    failure = { error };
  } finally {
    try {
      removeOwned(path, nonce);
    } catch (error) {
      failure ??= { error };
    }
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failure ??= { error };
    }
  }
  if (failure) throw failure.error;
  return result as T;
}
