// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { DragDropManager } from './dragDropManager';
import { installObsidianDomHelpers } from '../test/domHelpers';
import { setLocale } from '../i18n';

installObsidianDomHelpers();

describe('DragDropManager', () => {
	it('setups and teardowns event listeners correctly', () => {
		const targetEl = document.createElement('div');
		const overlayContainerEl = document.createElement('div');
		const manager = new DragDropManager(targetEl, overlayContainerEl, {
			onAddNoteRef: vi.fn(),
			onAddImagePart: vi.fn(),
			onRemoveImagePart: vi.fn(),
		});

		const addEventListenerSpy = vi.spyOn(targetEl, 'addEventListener');
		const removeEventListenerSpy = vi.spyOn(targetEl, 'removeEventListener');

		manager.setup();
		expect(addEventListenerSpy).toHaveBeenCalledWith('dragover', expect.any(Function));
		expect(addEventListenerSpy).toHaveBeenCalledWith('dragleave', expect.any(Function));
		expect(addEventListenerSpy).toHaveBeenCalledWith('drop', expect.any(Function));

		manager.teardown();
		expect(removeEventListenerSpy).toHaveBeenCalledWith('dragover', expect.any(Function));
		expect(removeEventListenerSpy).toHaveBeenCalledWith('dragleave', expect.any(Function));
		expect(removeEventListenerSpy).toHaveBeenCalledWith('drop', expect.any(Function));
	});

	it('shows and hides drag overlay', () => {
		setLocale('en');
		const targetEl = document.createElement('div');
		const overlayContainerEl = document.createElement('div');
		const manager = new DragDropManager(targetEl, overlayContainerEl, {
			onAddNoteRef: vi.fn(),
			onAddImagePart: vi.fn(),
			onRemoveImagePart: vi.fn(),
		});

		manager.setup();

		// Simulate dragover
		const dragOverEvent = new Event('dragover');
		Object.defineProperty(dragOverEvent, 'dataTransfer', {
			value: { types: ['Files'] },
		});
		targetEl.dispatchEvent(dragOverEvent);

		const overlay = overlayContainerEl.querySelector('.copsidian-drag-overlay');
		expect(overlay).not.toBeNull();
		expect(overlay?.textContent).toBe('Drop to attach');

		// Simulate dragleave
		const dragLeaveEvent = new Event('dragleave');
		targetEl.dispatchEvent(dragLeaveEvent);

		expect(overlayContainerEl.querySelector('.copsidian-drag-overlay')).toBeNull();
	});

	it('handles markdown file drop', () => {
		const targetEl = document.createElement('div');
		const overlayContainerEl = document.createElement('div');
		const onAddNoteRef = vi.fn();
		const manager = new DragDropManager(targetEl, overlayContainerEl, {
			onAddNoteRef,
			onAddImagePart: vi.fn(),
			onRemoveImagePart: vi.fn(),
		});

		manager.setup();

		// Show overlay first to test it gets removed on drop
		const dragOverEvent = new Event('dragover');
		Object.defineProperty(dragOverEvent, 'dataTransfer', {
			value: { types: ['Files'] },
		});
		targetEl.dispatchEvent(dragOverEvent);

		// Simulate drop
		const dropEvent = new Event('drop');
		Object.defineProperty(dropEvent, 'dataTransfer', {
			value: {
				files: [
					{ name: 'test.md', size: 100, type: 'text/markdown' },
				],
			},
		});
		targetEl.dispatchEvent(dropEvent);

		expect(overlayContainerEl.querySelector('.copsidian-drag-overlay')).toBeNull();
		expect(onAddNoteRef).toHaveBeenCalledWith({
			id: 'test.md',
			type: 'note',
			name: 'test',
			path: 'test.md',
		});
	});

	it('handles image file drop successfully', async () => {
		const targetEl = document.createElement('div');
		const overlayContainerEl = document.createElement('div');
		const onAddImagePart = vi.fn();
		const manager = new DragDropManager(targetEl, overlayContainerEl, {
			onAddNoteRef: vi.fn(),
			onAddImagePart,
			onRemoveImagePart: vi.fn(),
		});

		manager.setup();

		const mockFileReader = class {
			result!: string;
			onload!: () => void;
			onerror!: (e: any) => void;
			readAsDataURL() {
				setTimeout(() => {
					this.result = 'data:image/png;base64,mockbase64data';
					this.onload();
				}, 0);
			}
		};
		vi.stubGlobal('FileReader', mockFileReader);

		const dropEvent = new Event('drop');
		Object.defineProperty(dropEvent, 'dataTransfer', {
			value: {
				files: [
					{ name: 'image.png', size: 1024, type: 'image/png' },
				],
			},
		});
		targetEl.dispatchEvent(dropEvent);

		// wait for FileReader mock
		await new Promise(resolve => setTimeout(resolve, 0));

		expect(onAddImagePart).toHaveBeenCalledWith(
			'mockbase64data',
			'image/png',
			1024,
			'image.png'
		);

		vi.unstubAllGlobals();
	});

	it('rejects dropping images exceeding total 10MB limit', async () => {
		const targetEl = document.createElement('div');
		const overlayContainerEl = document.createElement('div');
		const onAddImagePart = vi.fn();
		const manager = new DragDropManager(targetEl, overlayContainerEl, {
			onAddNoteRef: vi.fn(),
			onAddImagePart,
			onRemoveImagePart: vi.fn(),
		});

		manager.setup();

		const dropEvent = new Event('drop');
		Object.defineProperty(dropEvent, 'dataTransfer', {
			value: {
				files: [
					{ name: 'large.png', size: 11 * 1024 * 1024, type: 'image/png' },
				],
			},
		});
		targetEl.dispatchEvent(dropEvent);

		// no reader should have been created
		expect(onAddImagePart).not.toHaveBeenCalled();
	});

	it('decreases bytes when image part is removed', async () => {
		const targetEl = document.createElement('div');
		const overlayContainerEl = document.createElement('div');
		const onAddImagePart = vi.fn();
		const manager = new DragDropManager(targetEl, overlayContainerEl, {
			onAddNoteRef: vi.fn(),
			onAddImagePart,
			onRemoveImagePart: vi.fn(),
		});

		manager.setup();

		const mockFileReader = class {
			result!: string;
			onload!: () => void;
			onerror!: (e: any) => void;
			readAsDataURL() {
				setTimeout(() => {
					this.result = 'data:image/png;base64,mock';
					this.onload();
				}, 0);
			}
		};
		vi.stubGlobal('FileReader', mockFileReader);

		const dropEvent = new Event('drop');
		Object.defineProperty(dropEvent, 'dataTransfer', {
			value: {
				files: [
					{ name: 'test.png', size: 5 * 1024 * 1024, type: 'image/png' },
				],
			},
		});
		targetEl.dispatchEvent(dropEvent);

		await new Promise(resolve => setTimeout(resolve, 0));

		// Now we should have 5MB used
		manager.onRemoveImagePart('mock', 5 * 1024 * 1024);

		// Try dropping a 6MB file, should pass since 5MB was freed
		const dropEvent2 = new Event('drop');
		Object.defineProperty(dropEvent2, 'dataTransfer', {
			value: {
				files: [
					{ name: 'test2.png', size: 6 * 1024 * 1024, type: 'image/png' },
				],
			},
		});
		targetEl.dispatchEvent(dropEvent2);

		await new Promise(resolve => setTimeout(resolve, 0));
		expect(onAddImagePart).toHaveBeenCalledTimes(2);

		vi.unstubAllGlobals();
	});
});
