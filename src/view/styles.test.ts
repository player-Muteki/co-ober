import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// The stylesheet is the last half of every control this plugin builds. These
// tests hold the two facts a reviewer cannot see from either side alone: that a
// class the code paints has a rule behind it, and that a rule the code relies on
// still wins the cascade.
const css = readFileSync('styles/main.css', 'utf8');

describe('the stylesheet and the DOM it is answerable to', () => {
  it('styles the origin chip the permission banner makes into a button', () => {
    // permissionBanner.ts builds this as role=button / tabindex=0 and moves
    // focus to the tab that asked. Unstyled, it read as a caption: no pointer,
    // no hover, and a keyboard reader could not tell the caret had arrived on
    // anything it could press.
    expect(css).toMatch(/\.co-ober-permission-banner \.perm-origin\s*\{[^}]*cursor:\s*pointer/);
    expect(css).toMatch(/\.co-ober-permission-banner \.perm-origin:focus-visible/);
  });

  it('lets the keyboard read the meter detail a mouse gets for free', () => {
    expect(css).toMatch(/\.co-ober-arc-meter:focus-visible/);
    expect(css).toMatch(/\.co-ober-arc-meter\[data-tooltip\]:focus-visible::after/);
  });

  it('anchors a fence\'s copy button to the fence', () => {
    // renderer.ts appends the button into the <pre> and styles it position:
    // absolute. With nothing establishing the fence as the containing block, the
    // nearest positioned ancestor is the message (.co-ober-msg), so every fence
    // in one answer parked its button on the same corner of the bubble — over
    // the timestamp, and over each other.
    expect(css).toMatch(/\.co-ober-code-block\s*\{[^}]*position:\s*relative/);
    expect(css).toMatch(/\.co-ober-copy-btn\s*\{[^}]*position:\s*absolute/);
  });

  it('styles the way back out of an error, including while it is working', () => {
    // addError builds this button and disables it while the retry runs. Unstyled,
    // it ran into the sentence reporting the failure as part of the report, and a
    // pressed button was indistinguishable from one nobody had pressed yet.
    expect(css).toMatch(/\.co-ober-error-action\s*\{/);
    expect(css).toMatch(/\.co-ober-error-action:disabled\s*\{[^}]*opacity/);
  });

  it('drops no rule for a class no code applies', () => {
    // A whole block styled .co-ober-tool-status with its own spinner. Nothing in
    // src/ ever wrote that class, so it was a status icon no tool card had —
    // and the animation inside it was one more thing reduced motion had to
    // cover while animating nothing.
    expect(css).not.toContain('co-ober-tool-status');
  });

  describe('prefers-reduced-motion', () => {
    const mediaAt = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)/g)].map((m) => m.index ?? -1);

    it('covers every animation the file declares', () => {
      // Two blocks would mean the earlier one is the one a reviewer reads and
      // the later one is the one the browser obeys.
      expect(mediaAt).toEqual([expect.any(Number)]);
      const mediaBlock = css.slice(mediaAt[0]);
      const animated = [...css.matchAll(/animation:\s*co-ober-[\w-]+/g)].map((m) => m.index ?? -1);
      expect(animated.length).toBeGreaterThan(0);
      // A media query adds no specificity, so a reduced-motion block parked
      // among the tab styles lost every tie against a spinner declared later,
      // and the setting looked like it did nothing.
      for (const declarationAt of animated) {
        expect(declarationAt).toBeGreaterThanOrEqual(0);
        expect(declarationAt).toBeLessThan(mediaAt[0]);
      }
      for (const selector of [
        '.co-ober-tab-pulse',
        '.co-ober-tool-call-header .tc-stat.spin svg',
        '.co-ober-spinner',
        '.co-ober-arc-meter.critical .co-ober-arc-fill',
        '.co-ober-thinking-block .co-ober-thinking-dot',
        '.co-ober-new-messages-btn',
      ]) {
        expect(mediaBlock).toContain(selector);
      }
    });

    it('leaves the pulsing things visible once they stop pulsing', () => {
      const mediaBlock = css.slice(mediaAt[0]);
      // animation: none alone would strand them at whatever opacity their last
      // keyframe held, so a stopped dot can be a dot no reader can see.
      expect(mediaBlock).toMatch(/\.co-ober-thinking-block \.co-ober-thinking-dot[^}]*\{[^}]*opacity:\s*1/);
    });
  });
});
