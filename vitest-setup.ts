// activeDocument is declared as a global by the Obsidian types (declare global).
// In tests, we need to provide a runtime value.
(globalThis as Record<string, unknown>).activeDocument = typeof document !== 'undefined' ? document : ({} as Document);

if (typeof globalThis.window === 'undefined') {
  const win: Record<string, any> = {};
  Object.defineProperties(win, {
    setTimeout: { get: () => globalThis.setTimeout.bind(globalThis), enumerable: true, configurable: true },
    clearTimeout: { get: () => globalThis.clearTimeout.bind(globalThis), enumerable: true, configurable: true },
    requestAnimationFrame: {
      get: () => (globalThis as any).requestAnimationFrame?.bind(globalThis) ?? ((cb: () => void) => globalThis.setTimeout(cb, 16)),
      enumerable: true,
      configurable: true,
    },
    cancelAnimationFrame: {
      get: () => (globalThis as any).cancelAnimationFrame?.bind(globalThis) ?? ((id: number) => globalThis.clearTimeout(id)),
      enumerable: true,
      configurable: true,
    },
  });
  Object.defineProperty(globalThis, 'window', { value: win, writable: true, configurable: true });
}
