// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from 'vitest';
import { createWriteEditBlock } from './writeEditRenderer';
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
    expect(state.header.getAttribute('aria-label')).toBe('Custom_tool: file - click to expand');
  });
});
