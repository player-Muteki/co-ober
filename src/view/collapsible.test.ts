// @vitest-environment happy-dom
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { setupCollapsible, type CollapsibleState } from './collapsible';
import { installObsidianDomHelpers } from '../test/domHelpers';
import { setLocale } from '../i18n/index';

installObsidianDomHelpers();

describe('setupCollapsible aria labels', () => {
  let wrapper: HTMLDivElement;
  let header: HTMLDivElement;
  let body: HTMLDivElement;
  let state: CollapsibleState;

  beforeEach(() => {
    setLocale('en');
    wrapper = document.createElement('div');
    header = document.createElement('div');
    body = document.createElement('div');
    wrapper.append(header, body);
    document.body.appendChild(wrapper);
    state = { isExpanded: false };
  });

  afterEach(() => {
    wrapper.remove();
  });

  it('builds the aria-label from the localized action word', () => {
    setupCollapsible(wrapper, header, body, state, { baseAriaLabel: 'Read note' });
    expect(header.getAttribute('aria-label')).toBe('Read note - click to expand');
    // The stored base is what lets a locale switch rebuild the label in place.
    expect(header.dataset.i18nToggle).toBe('Read note');

    header.click();
    expect(header.getAttribute('aria-label')).toBe('Read note - click to collapse');
  });

  it('uses the zh action words on toggle after a locale switch', () => {
    setupCollapsible(wrapper, header, body, state, { baseAriaLabel: 'Read note' });
    setLocale('zh');
    try {
      header.click();
      expect(header.getAttribute('aria-label')).toBe('Read note - 点击收起');
      header.click();
      expect(header.getAttribute('aria-label')).toBe('Read note - 点击展开');
    } finally {
      setLocale('en');
    }
  });

  it('leaves aria attributes untouched when no base label is given', () => {
    setupCollapsible(wrapper, header, body, state);
    header.click();
    expect(header.hasAttribute('aria-label')).toBe(false);
    expect(header.dataset.i18nToggle).toBeUndefined();
  });
});
