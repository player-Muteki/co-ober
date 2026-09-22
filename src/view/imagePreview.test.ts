// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from 'vitest';
import { openImagePreview, closeImagePreview, isImagePreviewOpen } from './imagePreview';
import { setLocale, t } from '../i18n/index';

describe('imagePreview', () => {
  afterEach(() => {
    closeImagePreview();
  });

  it('opens an overlay containing the image source and alt text', () => {
    openImagePreview('data:image/png;base64,AAA=', 'diagram');
    const overlay = document.querySelector('.co-ober-img-overlay');
    const img = document.querySelector('.co-ober-img-preview') as HTMLImageElement | null;
    expect(overlay).not.toBeNull();
    expect(img?.src).toBe('data:image/png;base64,AAA=');
    expect(img?.alt).toBe('diagram');
    expect(isImagePreviewOpen()).toBe(true);
  });

  it('replaces a previously open overlay', () => {
    openImagePreview('one');
    openImagePreview('two');
    expect(document.querySelectorAll('.co-ober-img-overlay')).toHaveLength(1);
    expect((document.querySelector('.co-ober-img-preview') as HTMLImageElement).getAttribute('src')).toBe('two');
  });

  it('closes on overlay click', () => {
    openImagePreview('x');
    document.querySelector('.co-ober-img-overlay')!.dispatchEvent(new Event('click', { bubbles: true }));
    expect(isImagePreviewOpen()).toBe(false);
    expect(document.querySelector('.co-ober-img-overlay')).toBeNull();
  });

  it('closes on Escape', () => {
    openImagePreview('x');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(isImagePreviewOpen()).toBe(false);
  });

  it('close is a no-op when nothing is open', () => {
    closeImagePreview();
    expect(isImagePreviewOpen()).toBe(false);
  });

  it('moves focus into the dialog overlay and restores it on close', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    openImagePreview('x', 'pic');
    const overlay = document.querySelector('.co-ober-img-overlay') as HTMLElement;
    expect(document.activeElement).toBe(overlay);
    expect(overlay.getAttribute('role')).toBe('dialog');
    expect(overlay.getAttribute('aria-modal')).toBe('true');
    expect(overlay.getAttribute('aria-label')).toBe('pic');

    closeImagePreview();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('keeps aria-label on the localized title when no alt text exists', () => {
    setLocale('en');
    openImagePreview('x');
    const overlay = document.querySelector('.co-ober-img-overlay') as HTMLElement;
    expect(overlay.getAttribute('aria-label')).toBe(t().lightbox.title);
    closeImagePreview();
  });

  it('traps Tab focus inside the overlay', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    openImagePreview('x');
    const overlay = document.querySelector('.co-ober-img-overlay') as HTMLElement;
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(overlay);

    closeImagePreview();
    trigger.remove();
  });
});
