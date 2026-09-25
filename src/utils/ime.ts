/**
 * During IME composition (Chinese/Japanese/etc.) the editor fires Enter and
 * printable-key events to confirm candidates, not to actuate the app. Engines
 * signal this via isComposing or, in older ones, only legacy keyCode 229.
 */
export function isImeComposing(e: KeyboardEvent): boolean {
  return e.isComposing === true || e.keyCode === 229;
}
