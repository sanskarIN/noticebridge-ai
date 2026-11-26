/** Shared bounded local input utilities for the offline research commands. */
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readSync,
  realpathSync, lstatSync, writeFileSync, unlinkSync, fsyncSync, writeSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';

export type LocalInput = { text: string; sha256: string; bytes: number };

export function readBounded(path: string, maximum: number): LocalInput {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || !lstatSync(path).isFile()) {
    throw new Error('Expected a bounded regular file.');
  }
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maximum) throw new Error('Input size limit.');
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (!count) break;
      offset += count;
    }
    const final = fstatSync(descriptor);
    if (offset !== stat.size || final.size !== stat.size || final.mtimeMs !== stat.mtimeMs) {
      throw new Error('Input changed during read.');
    }
    const bytes = buffer.subarray(0, offset);
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
      sha256: createHash('sha256').update(bytes).digest('hex'), bytes: offset };
  } finally { closeSync(descriptor); }
}
export function localFile(root: string, name: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}\.json$/.test(name)) throw new Error('Invalid input name.');
  const path = resolve(root, name);
  if (dirname(path) !== root || basename(path) !== name || realpathSync(path) !== path) {
    throw new Error('Input path escapes dataset.');
  }
  return path;
}
/** Exclusive file creation. If a write fails, remove only the file this
 * function opened; do not replace a pre-existing artifact. The caller
 * uses a trusted local output directory, not a shared writable directory.
 */
export function publishExclusive(path: string, text: string, maximum: number): void {
  const bytes = Buffer.from(text, 'utf8');
  if (!bytes.length || bytes.length > maximum) throw new Error('Output size limit.');
  const descriptor = openSync(path, 'wx', 0o600);
  let complete = false;
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count <= 0) throw new Error('Incomplete output write.');
      offset += count;
    }
    fsyncSync(descriptor);
    complete = true;
  } finally {
    closeSync(descriptor);
    if (!complete) unlinkSync(path);
  }
}
