// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from 'vitest';
import { createWriteEditBlock, updateWriteEditContent } from './writeEditRenderer';
import { relabelCollapsibleHeaders } from './collapsible';
import { installObsidianDomHelpers } from '../test/domHelpers';
import { setLocale } from '../i18n/index';

installObsidianDomHelpers();

describe('createWriteEditBlock', () => {
  let parent: HTMLDivElement;

  beforeEach(() => {
    setLocale('en');
    parent = document.createElement('div');
    document.body.appendChild(parent);
  });

  it('renders the localized display name and tags the raw kind for relabeling', () => {
    const state = createWriteEditBlock(parent, 'tc-1', 'edit', 'a.md');
    expect(state.nameEl.textContent).toBe('Edit');
    expect(state.nameEl.dataset.i18nKind).toBe('edit');
    expect(state.header.getAttribute('aria-label')).toBe('Edit: a.md - click to expand');
    expect(state.header.dataset.i18nToggle).toBe('Edit: a.md');
  });

  it('labels a non-English locale with the translated kind and action word', () => {
    setLocale('zh');
    try {
      const state = createWriteEditBlock(parent, 'tc-2', 'write', 'b.md');
      expect(state.nameEl.textContent).toBe('写入');
      expect(state.header.getAttribute('aria-label')).toBe('写入: b.md - 点击展开');
    } finally {
      setLocale('en');
    }
  });

  it('capitalizes unknown kinds and falls back to the file placeholder', () => {
    const state = createWriteEditBlock(parent, 'tc-3', 'custom_tool');
    expect(state.nameEl.textContent).toBe('Custom_tool');
    // The empty-file announcement is a word the locale owns, not the literal
    // "file" the composed string used to hardcode — so it re-speaks on a switch.
    expect(state.header.getAttribute('aria-label')).toBe('Custom_tool: Unnamed file - click to expand');
  });

  it('re-speaks a file-less card’s placeholder in the current locale', () => {
    // custom_tool has no localized kind word, so only the file placeholder and
    // the action word can move — exactly the composed base the old string froze.
    const state = createWriteEditBlock(parent, 'tc-4', 'custom_tool');
    setLocale('zh');
    try {
      relabelCollapsibleHeaders(parent);
      expect(state.header.getAttribute('aria-label')).toBe('Custom_tool: 未命名文件 - 点击展开');
    } finally {
      setLocale('en');
    }
  });
});

describe('updateWriteEditContent (0.2.14 stage 2)', () => {
  let parent: HTMLDivElement;

  beforeEach(() => {
    setLocale('en');
    parent = document.createElement('div');
    document.body.appendChild(parent);
  });

  it('renders the diff but declares no terminal state of its own', () => {
    const state = createWriteEditBlock(parent, 'tc-9', 'edit', 'a.md');
    // Open the card the way a reader would, then feed it a frame while its
    // status may still be in_progress (a write streams its new text).
    state.header.click();
    updateWriteEditContent(state, 'a.md', 'old\n', 'new\n');

    expect(state.body.textContent).toContain('new');
    // Stamping status-completed / emptying the glyph / collapsing here put a
    // finished look on a file still being written and shut a card open to watch.
    expect(state.wrapper.classList.contains('status-completed')).toBe(false);
    expect(state.collapsibleState.isExpanded).toBe(true);
    expect(state.wrapper.classList.contains('is-collapsed')).toBe(false);
  });
});
