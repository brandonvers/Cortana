import { describe, expect, it } from 'vitest';
import { AppError, isAppError, isBug } from './errors.ts';

describe('AppError', () => {
  it('carries the category, code, and detail it was given', () => {
    const error = new AppError('the database is ahead of this build', {
      category: 'storage',
      code: 'migration-ahead-of-binary',
      detail: { found: 12, expected: 9 },
    });

    expect(error.category).toBe('storage');
    expect(error.code).toBe('migration-ahead-of-binary');
    expect(error.detail['found']).toBe(12);
    expect(error.message).toBe('the database is ahead of this build');
  });

  it('is an Error, so nothing has to know about it to handle it', () => {
    const error = new AppError('nope', { category: 'internal', code: 'x' });

    expect(error).toBeInstanceOf(Error);
    expect(error.stack).toBeTruthy();
  });

  it('reports its own name rather than the base class name', () => {
    // Error only sets `name` for the class the constructor belongs to, so a
    // subclass that does not set it appears as "Error" in every log line and
    // stack trace it ever produces.
    class ConfigError extends AppError {}
    const error = new ConfigError('missing', { category: 'config', code: 'missing-setting' });

    expect(error.name).toBe('ConfigError');
    expect(new AppError('x', { category: 'config', code: 'y' }).name).toBe('AppError');
  });

  it('keeps the cause reachable', () => {
    const cause = new TypeError('underneath');
    const error = new AppError('on top', { category: 'storage', code: 'z', cause });

    expect(error.cause).toBe(cause);
  });

  it('defaults detail to an empty object rather than undefined', () => {
    // A logger that spreads `error.detail` should not have to guard first.
    expect(new AppError('x', { category: 'config', code: 'y' }).detail).toEqual({});
  });
});

describe('isAppError', () => {
  it('accepts ours and rejects everything else', () => {
    expect(isAppError(new AppError('x', { category: 'config', code: 'y' }))).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
    expect(isAppError('x')).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError(undefined)).toBe(false);
    expect(isAppError({ category: 'config', code: 'y', message: 'x' })).toBe(false);
  });
});

describe('isBug', () => {
  it('calls an internal error a bug', () => {
    expect(isBug(new AppError('x', { category: 'internal', code: 'y' }))).toBe(true);
  });

  it('does not call an operator mistake a bug', () => {
    for (const category of ['config', 'contract', 'storage', 'timeout'] as const) {
      expect(isBug(new AppError('x', { category, code: 'y' }))).toBe(false);
    }
  });

  it('calls anything unrecognised a bug', () => {
    // The important half. A TypeError reaching the top level is a defect just as
    // much as an explicit `internal` is, and treating "not one of ours" as
    // "probably fine" is how a real bug becomes a log line nobody reads.
    expect(isBug(new TypeError('undefined is not a function'))).toBe(true);
    expect(isBug('a thrown string')).toBe(true);
    expect(isBug(undefined)).toBe(true);
  });
});
