import { describe, expect, it } from 'vitest';
import { isImeComposing } from './ime';

function keyEvent(init: { isComposing?: boolean; keyCode?: number }): KeyboardEvent {
  const e = { isComposing: init.isComposing ?? false } as unknown as KeyboardEvent;
  if (init.keyCode !== undefined) {
    Object.defineProperty(e, 'keyCode', { value: init.keyCode });
  }
  return e;
}

describe('isImeComposing', () => {
  it('is false for a plain key event', () => {
    expect(isImeComposing(keyEvent({}))).toBe(false);
  });

  it('detects composition via isComposing', () => {
    expect(isImeComposing(keyEvent({ isComposing: true }))).toBe(true);
  });

  it('detects legacy engines that only report keyCode 229', () => {
    expect(isImeComposing(keyEvent({ keyCode: 229 }))).toBe(true);
  });

  it('ignores other legacy keyCodes', () => {
    expect(isImeComposing(keyEvent({ keyCode: 13 }))).toBe(false);
  });
});
