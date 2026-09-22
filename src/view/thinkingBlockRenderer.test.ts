// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  renderLiveThinkingBlock,
  appendThinkingContent,
  finalizeThinkingBlock,
  renderStoredThinkingBlock,
  cleanupThinkingBlock,
} from './thinkingBlockRenderer';
import { installObsidianDomHelpers } from '../test/domHelpers';
import { setLocale } from '../i18n/index';

installObsidianDomHelpers();

function makeLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n');
}

describe('thinkingBlockRenderer', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    setLocale('en');
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    container.remove();
  });

  describe('renderLiveThinkingBlock', () => {
    it('renders header label "Thinking" with timer and dot spans', () => {
      const state = renderLiveThinkingBlock(container);
      expect(state.wrapper.classList.contains('co-ober-thinking-block')).toBe(true);
      expect(state.wrapper.classList.contains('is-thinking')).toBe(true);
      expect(state.labelEl.classList.contains('co-ober-thinking-label')).toBe(true);
      expect(state.labelEl.textContent).toBe('Thinking');
      expect(state.timerEl.classList.contains('co-ober-thinking-timer')).toBe(true);
      expect(state.timerEl.textContent).toBe('0s');
      expect(state.header.querySelector('.co-ober-thinking-dot')?.textContent).toBe('···');
      cleanupThinkingBlock(state);
    });

    it('exposes an "Extended thinking" base aria label and starts collapsed', () => {
      const state = renderLiveThinkingBlock(container);
      expect(state.header.getAttribute('role')).toBe('button');
      expect(state.header.getAttribute('tabindex')).toBe('0');
      expect(state.header.getAttribute('aria-label')).toBe('Extended thinking - click to expand');
      expect(state.header.getAttribute('aria-expanded')).toBe('false');
      expect(state.wrapper.classList.contains('is-collapsed')).toBe(true);
      cleanupThinkingBlock(state);
    });

    it('updates the live timer and dot animation on intervals', () => {
      const state = renderLiveThinkingBlock(container);
      const dotEl = state.header.querySelector('.co-ober-thinking-dot') as HTMLElement;
      vi.advanceTimersByTime(500);
      expect(dotEl.textContent).toBe('··');
      vi.advanceTimersByTime(500);
      expect(state.timerEl.textContent).toBe('1s');
      expect(dotEl.textContent).toBe('···');
      vi.advanceTimersByTime(2000);
      expect(state.timerEl.textContent).toBe('3s');
      cleanupThinkingBlock(state);
    });

    it('stays collapsed while streaming content', () => {
      const state = renderLiveThinkingBlock(container);
      appendThinkingContent(state, 'reasoning...');
      expect(state.collapsibleState.isExpanded).toBe(false);
      expect(state.body.textContent).toBe('');
      cleanupThinkingBlock(state);
    });
  });

  describe('appendThinkingContent', () => {
    it('accumulates full text without re-rendering the body', () => {
      const state = renderLiveThinkingBlock(container);
      appendThinkingContent(state, 'part one ');
      appendThinkingContent(state, 'part two');
      expect(state.fullText).toBe('part one part two');
      expect(state.body.textContent).toBe('');
      cleanupThinkingBlock(state);
    });
  });

  describe('finalizeThinkingBlock', () => {
    it('relabells to "Thought", returns elapsed seconds and reports "for Ns"', () => {
      const state = renderLiveThinkingBlock(container);
      appendThinkingContent(state, 'deep thoughts');
      vi.advanceTimersByTime(2000);
      const elapsed = finalizeThinkingBlock(state);
      expect(elapsed).toBe(2);
      expect(state.labelEl.textContent).toBe('Thought');
      expect(state.timerEl.textContent).toBe('for 2s');
    });

    it('removes the dot indicator, stores text and auto-collapses', () => {
      const state = renderLiveThinkingBlock(container);
      appendThinkingContent(state, 'the answer');
      state.header.click();
      expect(state.collapsibleState.isExpanded).toBe(true);
      vi.advanceTimersByTime(1000);
      finalizeThinkingBlock(state);
      expect(state.header.querySelector('.co-ober-thinking-dot')).toBeNull();
      expect(state.body.textContent).toBe('the answer');
      expect(state.collapsibleState.isExpanded).toBe(false);
      expect(state.header.getAttribute('aria-expanded')).toBe('false');
      expect(state.wrapper.classList.contains('is-thinking')).toBe(false);
      expect(state.wrapper.classList.contains('is-collapsed')).toBe(true);
    });

    it('stops the live timer after finalization', () => {
      const state = renderLiveThinkingBlock(container);
      vi.advanceTimersByTime(1500);
      finalizeThinkingBlock(state);
      expect(state.timerEl.textContent).toBe('for 1s');
      vi.advanceTimersByTime(5000);
      expect(state.timerEl.textContent).toBe('for 1s');
    });
  });

  describe('live block expand truncation', () => {
    it('truncates to 30 lines with a "Show all ›" link and expands on click', () => {
      const state = renderLiveThinkingBlock(container);
      const full = makeLines(35);
      appendThinkingContent(state, full);
      state.header.click();

      const textEl = state.body.querySelector('.co-ober-thinking-text') as HTMLElement;
      expect(textEl).not.toBeNull();
      expect(textEl.textContent).toBe(makeLines(30));
      const showAll = state.body.querySelector('.co-ober-thinking-show-all') as HTMLButtonElement;
      expect(showAll).not.toBeNull();
      expect(showAll.textContent).toBe('Show all ›');

      showAll.click();
      expect(state.showingFull).toBe(true);
      expect(state.body.textContent).toBe(full);
      cleanupThinkingBlock(state);
    });

    it('shows short content in full without a "Show all" link', () => {
      const state = renderLiveThinkingBlock(container);
      appendThinkingContent(state, 'one\ntwo');
      state.header.click();
      expect(state.body.textContent).toBe('one\ntwo');
      expect(state.body.querySelector('.co-ober-thinking-show-all')).toBeNull();
      cleanupThinkingBlock(state);
    });

    it('renders nothing on expand when there is no content', () => {
      const state = renderLiveThinkingBlock(container);
      state.header.click();
      expect(state.body.children.length).toBe(0);
      cleanupThinkingBlock(state);
    });
  });

  describe('renderStoredThinkingBlock', () => {
    it('labels a block without duration as "Thinking"', () => {
      const wrapper = renderStoredThinkingBlock(container, 'stored text');
      expect(wrapper.querySelector('.co-ober-thinking-label')?.textContent).toBe('Thinking');
      expect(wrapper.querySelector('.co-ober-thinking-timer')).toBeNull();
      expect(wrapper.querySelector('.co-ober-thinking-body')?.textContent).toBe('stored text');
      expect(wrapper.getAttribute('class')).toContain('co-ober-thinking-block');
    });

    it('labels a block with duration as "Thought" plus "for Ns"', () => {
      const wrapper = renderStoredThinkingBlock(container, 'was thinking', 12);
      expect(wrapper.querySelector('.co-ober-thinking-label')?.textContent).toBe('Thought');
      expect(wrapper.querySelector('.co-ober-thinking-timer')?.textContent).toBe('for 12s');
      expect(wrapper.querySelector('.co-ober-thinking-header')?.getAttribute('aria-label'))
        .toBe('Extended thinking - click to expand');
    });

    it('truncates long content on first expand and restores it via "Show all"', () => {
      const full = makeLines(40);
      const wrapper = renderStoredThinkingBlock(container, full);
      const header = wrapper.querySelector('.co-ober-thinking-header') as HTMLElement;
      const body = wrapper.querySelector('.co-ober-thinking-body') as HTMLElement;

      header.click();
      const textEl = body.querySelector('.co-ober-thinking-text') as HTMLElement;
      expect(textEl.textContent).toBe(makeLines(30));
      const showAll = body.querySelector('.co-ober-thinking-show-all') as HTMLButtonElement;
      expect(showAll.textContent).toBe('Show all ›');

      showAll.click();
      expect(body.textContent).toBe(full);
    });

    it('leaves short content untouched on expand', () => {
      const wrapper = renderStoredThinkingBlock(container, 'short');
      const header = wrapper.querySelector('.co-ober-thinking-header') as HTMLElement;
      const body = wrapper.querySelector('.co-ober-thinking-body') as HTMLElement;
      header.click();
      expect(body.textContent).toBe('short');
      expect(body.querySelector('.co-ober-thinking-show-all')).toBeNull();
    });
  });

  describe('cleanupThinkingBlock', () => {
    it('stops both the timer and the dot animation', () => {
      const state = renderLiveThinkingBlock(container);
      vi.advanceTimersByTime(1200);
      const dotEl = state.header.querySelector('.co-ober-thinking-dot') as HTMLElement;
      cleanupThinkingBlock(state);
      const timerText = state.timerEl.textContent;
      const dotText = dotEl.textContent;
      vi.advanceTimersByTime(5000);
      expect(state.timerEl.textContent).toBe(timerText);
      expect(dotEl.textContent).toBe(dotText);
    });
  });
});
