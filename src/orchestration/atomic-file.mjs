import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';

import { AiCliError } from '../errors.mjs';
import { basename, dirname, join } from 'node:path';

import { randomBytes } from 'node:crypto';

let tempCounter = 0;

/**
 * Write a JSON value atomically: temp sibling (mode 0600 by default), one
 * trailing newline, file fsync, atomic rename, then a best-effort parent
 * directory sync on POSIX.
 */
export function writeAtomicJson(filePath, value, { mode = 0o600 } = {}) {
  return writeAtomicFile(filePath, `${JSON.stringify(value)}\n`, { mode });
}

export function writeAtomicFile(filePath, contents, { mode = 0o600 } = {}) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  tempCounter += 1;
  const tmpPath = join(
    dir,
    `.${basename(filePath)}.tmp-${process.pid}-${tempCounter}-${randomBytes(4).toString('hex')}`,
  );
  const fd = openSync(tmpPath, 'wx', mode);
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, filePath);
  try {
    const dirFd = openSync(dir, 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Directory fsync is POSIX-only; ignore on platforms that reject it.
  }
  return filePath;
}

/**
 * Exclusive-create write: the file is created atomically ('wx') and any
 * collision is REFUSED with a typed error — existing evidence is never
 * silently overwritten. Callers that need uniqueness should pass a
 * namespaced path and may retry with an explicit suffix themselves.
 */
export function createAtomicExclusiveFile(filePath, contents, { mode = 0o600 } = {}) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = openSync(filePath, 'wx', mode);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new AiCliError('ORCHESTRATION_INVALID_INPUT', `refusal: ${basename(filePath)} already exists (collision refused)`);
    }
    throw error;
  }
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return filePath;
}
