/**
 * Cross-environment safe clone utility.
 *
 * `structuredClone` is available in modern Chromium (>=98) but Obsidian on
 * older Electron may not expose it. `JSON.parse/stringify` is the portable
 * fallback — it handles plain objects, arrays, strings, numbers, booleans,
 * and null which covers all data flowing through co-ober's data-path objects.
 */
export function safeClone<T>(obj: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(obj);
  }
  return JSON.parse(JSON.stringify(obj));
}
