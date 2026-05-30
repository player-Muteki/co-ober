import { Notice } from 'obsidian';
import type { AgentCapabilities, ContextRef } from '../types';
import { t, onLocaleChange } from '../i18n/index';

export interface DragDropHandlers {
	onAddNoteRef: (ref: ContextRef) => void;
	onAddImagePart: (data: string, mimeType: string, size: number, name: string) => void;
	onRemoveImagePart: (data: string, size: number) => void;
}

export class DragDropManager {
	private dragOverlayEl: HTMLDivElement | null = null;
	private pendingImageTotalBytes = 0;
	private static readonly MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB

	private dragOverHandler: ((e: DragEvent) => void) | null = null;
	private dragLeaveHandler: ((e: DragEvent) => void) | null = null;
	private dropHandler: ((e: DragEvent) => void) | null = null;

	constructor(
		private dropZoneEl: HTMLElement,
		private overlayContainerEl: HTMLElement,
		private handlers: DragDropHandlers,
		private getAgentCapabilities: () => AgentCapabilities | null = () => null
	) {
		onLocaleChange(() => {
			if (this.dragOverlayEl) {
				const textDiv = this.dragOverlayEl.querySelector('div');
				if (textDiv) textDiv.textContent = t().dragOverlay;
			}
		});
	}

	setup(): void {
		this.dragOverHandler = (e: DragEvent) => {
			e.preventDefault();
			e.dataTransfer!.dropEffect = 'copy';
			this.showDragOverlay();
		};
		this.dropZoneEl.addEventListener('dragover', this.dragOverHandler);

		this.dragLeaveHandler = (e: DragEvent) => {
			if (!this.dropZoneEl.contains(e.relatedTarget as Node)) {
				this.hideDragOverlay();
			}
		};
		this.dropZoneEl.addEventListener('dragleave', this.dragLeaveHandler);

		this.dropHandler = async (e: DragEvent) => {
			e.preventDefault();
			this.hideDragOverlay();
			await this.handleDrop(e);
		};
		this.dropZoneEl.addEventListener('drop', this.dropHandler);
	}

	teardown(): void {
		if (this.dragOverHandler) {
			this.dropZoneEl.removeEventListener('dragover', this.dragOverHandler);
			this.dragOverHandler = null;
		}
		if (this.dragLeaveHandler) {
			this.dropZoneEl.removeEventListener('dragleave', this.dragLeaveHandler);
			this.dragLeaveHandler = null;
		}
		if (this.dropHandler) {
			this.dropZoneEl.removeEventListener('drop', this.dropHandler);
			this.dropHandler = null;
		}
	}

	private showDragOverlay(): void {
		if (this.dragOverlayEl) return;
		const overlay = this.overlayContainerEl.createDiv({ cls: 'copsilot-drag-overlay' });
		overlay.createDiv({ text: t().dragOverlay });
		this.dragOverlayEl = overlay;
	}

	private hideDragOverlay(): void {
		this.dragOverlayEl?.remove();
		this.dragOverlayEl = null;
	}

	resetBytes(): void {
		this.pendingImageTotalBytes = 0;
	}

	onRemoveImagePart(data: string, size: number): void {
		this.pendingImageTotalBytes -= size;
		this.handlers.onRemoveImagePart(data, size);
	}

	private async handleDrop(e: DragEvent): Promise<void> {
		const files = e.dataTransfer?.files;
		if (!files?.length) return;

		for (const file of Array.from(files)) {
			if (file.name.endsWith('.md')) {
				// Markdown file → ContextRef
				const path = file.webkitRelativePath || file.name;
				const ref: ContextRef = {
					id: path,
					type: 'note',
					name: file.name.replace(/\.md$/, ''),
					path,
				};
				this.handlers.onAddNoteRef(ref);
			} else if (file.type.startsWith('image/')) {
				if (this.getAgentCapabilities()?.promptCapabilities?.image === false) {
					new Notice(t().dragDrop.imageNotSupported);
					continue;
				}
				// Image → base64 PromptPart
				try {
					const data = await this.fileToBase64(file);
					const imageBytes = file.size;
					if (this.pendingImageTotalBytes + imageBytes > DragDropManager.MAX_IMAGE_BYTES) {
						console.warn(`[copsilot] Image "${file.name}" exceeds total size limit (10MB), skipped`);
						continue;
					}
					this.pendingImageTotalBytes += imageBytes;

					this.handlers.onAddImagePart(data, file.type, imageBytes, file.name);
				} catch (err) {
					console.error('[copsilot] Failed to read image:', err);
				}
			}
		}
	}

	private fileToBase64(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				const result = reader.result as string;
				resolve(result.split(',')[1]);
			};
			reader.onerror = reject;
			reader.readAsDataURL(file);
		});
	}
}
