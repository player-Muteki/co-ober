/**
 * During IME composition (Chinese/Japanese/etc.) the editor fires Enter and
 * printable-key events to confirm candidates, not to actuate the app. Engines
 * signal this via isComposing; the standard alternative for a key we cannot
 * resolve on its own is `key === 'Process'`, which every Electron runtime
 * shipping an IME reports in place of the deprecated keyCode 229.
 */
export function isImeComposing(e: KeyboardEvent): boolean {
  return e.isComposing === true || e.key === 'Process';
}
