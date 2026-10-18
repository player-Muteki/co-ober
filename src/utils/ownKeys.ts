/**
 * Own-key access for maps whose keys come off the wire.
 *
 * An agent chooses the keys of an elicitation form, and this plugin echoes those keys
 * back as the reader's answers. Both halves of that round trip are unsafe on a plain
 * object, and Claudian hit the same pair at 2.3.24 in its own form-answer path:
 *
 * - **Reading** `source[key]` walks the prototype chain. A field named `toString` or
 *   `constructor` has no own entry, so the read returns the inherited member — a
 *   *function* — which then sails past a `value !== undefined` guard and is sent to the
 *   agent as something the reader typed. A key-restriction check written this way does
 *   not restrict anything for those names.
 * - **Writing** `target[key] = value` for `key === "__proto__"` goes through the
 *   prototype setter. With a primitive value the assignment is silently discarded, so a
 *   field the reader filled in disappears while the elicitation still answers
 *   `accept` — the form reports itself complete over a missing answer.
 *
 * `Object.hasOwn` settles the read and `Object.defineProperty` settles the write: the key
 * becomes an ordinary own property, enumerable so it serialises onto the wire, and
 * independent of the prototype.
 *
 * This is a refusal to launder a key, not a defence against a hostile agent: the value
 * here is a string, number or boolean the reader typed. The bug is that an answer the
 * reader gave can be silently replaced by a prototype member, or silently dropped.
 */
export function readOwnKey(source: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(source, key) ? source[key] : undefined;
}

/** Assign as an own, enumerable property so the key survives `__proto__` and serialises. */
export function writeOwnKey<T>(target: Record<string, T>, key: string, value: T): Record<string, T> {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return target;
}
