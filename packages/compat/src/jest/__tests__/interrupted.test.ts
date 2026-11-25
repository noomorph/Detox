import { describe, expect, it } from 'vitest';
import { AbortError } from 'detox/client';

import { appendToFailure, collectInterrupted, interruptedLine } from '../interrupted';

describe('the interrupted-call line (spec 020)', () => {
  it('names the method, the stated wait and its duration — only for a cancellation that carried one', () => {
    expect(interruptedLine('launchApp', new AbortError(undefined, { waiting: { on: 'spawning', forMs: 12 } }))).toBe(
      'Interrupted: launchApp — spawning for 12ms',
    );
    expect(interruptedLine('launchApp', new AbortError(undefined, { outcome: 'undone' }))).toBeUndefined();
    expect(interruptedLine('launchApp', null)).toBeUndefined();
  });

  it('a call that resolved after all contributes nothing', async () => {
    expect(await collectInterrupted([{ method: 'invoke', call: Promise.resolve() }])).toEqual([]);
  });

  it('amends an error object in place, its stack included', () => {
    const error = new Error('boom');
    appendToFailure(error, [], 'Interrupted: invoke — x for 1ms');
    expect(error.message).toBe('boom\n\nInterrupted: invoke — x for 1ms');
    expect(error.stack).toContain('boom\n\nInterrupted: invoke — x for 1ms');
  });

  it('treats the message as literal text, and amends the latest tuple carrying a thrown string', () => {
    const error = new Error('cost $& more');
    appendToFailure(error, [], 'line');
    expect(error.stack).toContain('cost $& more\n\nline');
    const list: unknown[] = [['verdict', 'first'], ['verdict', 'second'], ['other', 'third']];
    appendToFailure('verdict', [list], 'line');
    expect(list).toEqual([['verdict', 'first'], ['verdict\n\nline', 'second'], ['other', 'third']]);
  });

  it('leaves a frozen error, a non-error and an unrelated tuple alone', () => {
    const frozen = Object.freeze(new Error('cold'));
    appendToFailure(frozen, [], 'line');
    expect(frozen.message).toBe('cold');
    appendToFailure(42, [], 'line');
    const list: unknown[] = [['another verdict', undefined]];
    appendToFailure('this verdict', [list], 'line');
    expect(list).toEqual([['another verdict', undefined]]);
  });
});
