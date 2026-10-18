import { describe, expect, it } from 'vitest';
import { readOwnKey, writeOwnKey } from './ownKeys';

describe('readOwnKey', () => {
  it('reads an own property the caller really set', () => {
    expect(readOwnKey({ name: 'Co-Ober' }, 'name')).toBe('Co-Ober');
  });

  it('refuses to satisfy a read from the prototype chain', () => {
    // The bug this exists for: an elicitation field named after a prototype member has no
    // own entry, and a plain read would hand back that member — a function — which then
    // passes a `!== undefined` guard and reaches the agent as the reader's answer.
    for (const key of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(readOwnKey({}, key)).toBeUndefined();
      expect(readOwnKey({ other: 'x' }, key)).toBeUndefined();
    }
  });

  it('still reads a key that shadows a prototype member as its own value', () => {
    expect(readOwnKey({ toString: 'typed by the reader' }, 'toString')).toBe('typed by the reader');
  });

  it('distinguishes an own key holding undefined from an absent key only by presence', () => {
    // Both answer undefined, which is what the callers want: neither is an answer to send.
    expect(readOwnKey({ a: undefined }, 'a')).toBeUndefined();
    expect(readOwnKey({}, 'a')).toBeUndefined();
  });
});

describe('writeOwnKey', () => {
  it('stores an ordinary key as an own enumerable property', () => {
    const target: Record<string, string> = {};
    writeOwnKey(target, 'model', 'alpha');
    expect(target.model).toBe('alpha');
    // Enumerable so it still serialises onto the wire.
    expect(Object.keys(target)).toEqual(['model']);
    expect(JSON.parse(JSON.stringify(target))).toEqual({ model: 'alpha' });
  });

  it('keeps a value written under the prototype key instead of discarding it', () => {
    // `target['__proto__'] = 'x'` is a silent no-op on a plain object, so the field the
    // reader filled in would vanish while the elicitation still answered "accept".
    const target: Record<string, string> = {};
    writeOwnKey(target, '__proto__', 'typed by the reader');
    expect(readOwnKey(target, '__proto__')).toBe('typed by the reader');
    expect(Object.hasOwn(target, '__proto__')).toBe(true);
    expect(Object.keys(target)).toEqual(['__proto__']);
    // And the prototype itself is untouched — this is not pollution, it is a normal key.
    expect(({} as Record<string, unknown>).typed).toBeUndefined();
  });

  it('does not let a written key overwrite a prototype member either', () => {
    const target: Record<string, string> = {};
    writeOwnKey(target, 'toString', 'not a function');
    expect(String(readOwnKey(target, 'toString'))).toBe('not a function');
    expect(typeof ({}).toString).toBe('function');
  });

  it('overwrites its own earlier value rather than defining a second property', () => {
    const target: Record<string, string> = {};
    writeOwnKey(target, 'k', 'first');
    writeOwnKey(target, 'k', 'second');
    expect(Object.keys(target)).toEqual(['k']);
    expect(target.k).toBe('second');
  });

  it('survives a round trip through JSON, which a non-enumerable write would not', () => {
    const target: Record<string, string> = {};
    writeOwnKey(target, '__proto__', 'kept');
    // Asserted with an own-key read rather than an object literal, because the literal
    // `{ __proto__: 'kept' }` would set a prototype instead of naming a key — the very
    // confusion this module exists to remove.
    const parsed = JSON.parse(JSON.stringify(target)) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
    expect(readOwnKey(parsed, '__proto__')).toBe('kept');
  });
});
