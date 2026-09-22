// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from 'vitest';
import { openImagePreview, closeImagePreview, isImagePreviewOpen } from './imagePreview';

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
});
