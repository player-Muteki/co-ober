import { describe, expect, it } from 'vitest';
import { isImeComposing } from './ime';

function keyEvent(init: { isComposing?: boolean; key?: string }): KeyboardEvent {
  return {
    isComposing: init.isComposing ?? false,
    key: init.key ?? 'a',
  } as unknown as KeyboardEvent;
}

describe('isImeComposing', () => {
  it('is false for a plain key event', () => {
    expect(isImeComposing(keyEvent({}))).toBe(false);
  });

  it('detects composition via isComposing', () => {
    expect(isImeComposing(keyEvent({ isComposing: true }))).toBe(true);
  });

  it('detects engines that only report key === "Process"', () => {
    expect(isImeComposing(keyEvent({ key: 'Process' }))).toBe(true);
  });

  it('ignores other named keys', () => {
    expect(isImeComposing(keyEvent({ key: 'Enter' }))).toBe(false);
  });
});
