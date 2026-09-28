// @vitest-environment happy-dom
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { setupCollapsible, collapseElement, relabelCollapsibleHeaders, type CollapsibleState } from './collapsible';
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

describe('collapsible headers that compose their label (0.2.14 stage 2)', () => {
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

  it('reads the base off the header’s own words when given a builder', () => {
    const summary = document.createElement('span');
    summary.textContent = 'old';
    header.append(summary);
    setupCollapsible(wrapper, header, body, state, { baseAriaLabel: () => `Edit: ${summary.textContent}` });
    expect(header.getAttribute('aria-label')).toBe('Edit: old - click to expand');

    summary.textContent = 'new';
    header.click();
    // A label frozen at creation kept announcing a path the card no longer shows.
    expect(header.getAttribute('aria-label')).toBe('Edit: new - click to collapse');
  });

  it('re-speaks the action word when the turn collapses a card the reader opened', () => {
    setupCollapsible(wrapper, header, body, state, { baseAriaLabel: () => 'Read note' });
    header.click();
    expect(header.getAttribute('aria-label')).toBe('Read note - click to collapse');
    collapseElement(wrapper, header, state);
    // collapseElement changed the visible state; the label has to follow or it
    // invites a click to collapse a block that is already collapsed.
    expect(header.getAttribute('aria-label')).toBe('Read note - click to expand');
  });

  it('re-scores a composed base in the current locale via relabelCollapsibleHeaders', () => {
    setupCollapsible(wrapper, header, body, state, { baseAriaLabel: () => 'Read note' });
    setLocale('zh');
    try {
      relabelCollapsibleHeaders(document.body);
      expect(header.getAttribute('aria-label')).toBe('Read note - 点击展开');
    } finally {
      setLocale('en');
    }
  });
});
