import { t } from '../i18n/index';

let activeOverlay: HTMLDivElement | null = null;
let previouslyFocused: HTMLElement | null = null;

function close(): void {
  if (!activeOverlay) return;
  activeOverlay.remove();
  activeOverlay = null;
  document.removeEventListener('keydown', onKeydown);
  const doc = globalThis.document;
  // Hand focus back to the chat element that opened the preview, but only if
  // it is still attached to the page (the transcript may have re-rendered).
  if (previouslyFocused && doc && doc.contains(previouslyFocused) && typeof previouslyFocused.focus === 'function') {
    previouslyFocused.focus();
  }
  previouslyFocused = null;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation();
    close();
  } else if (event.key === 'Tab' && activeOverlay) {
    // Single-element dialog: keep focus inside the overlay.
    event.preventDefault();
    activeOverlay.focus();
  }
}

/** Open a full-width lightbox overlay for a chat image (data: or vault URL src). */
export function openImagePreview(src: string, alt?: string): void {
  close();
  const doc = globalThis.document;
  if (!doc) return;
  const active = doc.activeElement;
  previouslyFocused = active instanceof HTMLElement ? active : null;
  const overlay = doc.createElement('div');
  overlay.className = 'co-ober-img-overlay';
  overlay.tabIndex = -1;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', alt || t().lightbox.title);
  const img = doc.createElement('img');
  img.src = src;
  img.alt = alt ?? '';
  img.className = 'co-ober-img-preview';
  overlay.appendChild(img);
  overlay.addEventListener('click', () => close());
  doc.body.appendChild(overlay);
  activeOverlay = overlay;
  overlay.focus();
  doc.addEventListener('keydown', onKeydown);
}

export function closeImagePreview(): void {
  close();
}

export function isImagePreviewOpen(): boolean {
  return activeOverlay !== null;
}
