let activeOverlay: HTMLDivElement | null = null;

function close(): void {
  if (!activeOverlay) return;
  activeOverlay.remove();
  activeOverlay = null;
  document.removeEventListener('keydown', onKeydown);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation();
    close();
  }
}

/** Open a full-width lightbox overlay for a chat image (data: or vault URL src). */
export function openImagePreview(src: string, alt?: string): void {
  close();
  const doc = globalThis.document;
  if (!doc) return;
  const overlay = doc.createElement('div');
  overlay.className = 'co-ober-img-overlay';
  const img = doc.createElement('img');
  img.src = src;
  img.alt = alt ?? '';
  img.className = 'co-ober-img-preview';
  overlay.appendChild(img);
  overlay.addEventListener('click', () => close());
  doc.body.appendChild(overlay);
  activeOverlay = overlay;
  doc.addEventListener('keydown', onKeydown);
}

export function closeImagePreview(): void {
  close();
}

export function isImagePreviewOpen(): boolean {
  return activeOverlay !== null;
}
