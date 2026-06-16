// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ChatInput } from './input';
import { installObsidianDomHelpers } from '../test/domHelpers';
import { setLocale } from '../i18n/index';

installObsidianDomHelpers();

describe('ChatInput', () => {
	let container: HTMLDivElement;
	let callbacks: any;
	let chatInput: ChatInput;

	beforeEach(() => {
		setLocale('en');
		container = document.createElement('div');
		document.body.appendChild(container);
		callbacks = {
			onSend: vi.fn(),
			onStop: vi.fn(),
			onToggleMention: vi.fn(),
			onToggleSlash: vi.fn(),
			onAddRef: vi.fn(),
			onRemoveRef: vi.fn(),
		};
		chatInput = new ChatInput(container, callbacks);
	});

	it('initializes textarea and resize handle', () => {
		const handle = container.querySelector('.co-ober-input-resize-handle');
		const textarea = container.querySelector('textarea');
		expect(handle).not.toBeNull();
		expect(textarea).not.toBeNull();
		expect(textarea?.classList.contains('co-ober-input')).toBe(true);
	});

	it('triggerSend calls onSend and clears textarea', () => {
		const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
		textarea.value = 'Hello world';
		chatInput.triggerSend();

		expect(callbacks.onSend).toHaveBeenCalledWith('Hello world', []);
		expect(textarea.value).toBe('');
	});

	it('triggerSend does not call onSend if empty', () => {
		chatInput.triggerSend();
		expect(callbacks.onSend).not.toHaveBeenCalled();
	});

	it('triggerStop calls onStop', () => {
		chatInput.triggerStop();
		expect(callbacks.onStop).toHaveBeenCalled();
	});

	it('setStreaming tracks streaming state', () => {
		chatInput.setStreaming(true);
		expect(chatInput.isStreaming()).toBe(true);

		chatInput.setStreaming(false);
		expect(chatInput.isStreaming()).toBe(false);
	});

	it('setDisabled disables textarea', () => {
		chatInput.setDisabled(true);
		const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
		expect(textarea.disabled).toBe(true);

		chatInput.setDisabled(false);
		expect(textarea.disabled).toBe(false);
	});

	it('appendValue appends text', () => {
		const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
		chatInput.appendValue('Hello');
		expect(textarea.value).toBe('Hello');
		chatInput.appendValue(' World');
		expect(textarea.value).toBe('Hello World');
	});

	it('focus focuses textarea', () => {
		const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
		const focusSpy = vi.spyOn(textarea, 'focus');
		chatInput.focus();
		expect(focusSpy).toHaveBeenCalled();
	});

	describe('keydown events', () => {
		it('Tab cycles mode forward', () => {
			const onCycleMode = vi.fn();
			callbacks.onCycleMode = onCycleMode;
			const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
			const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: false });
			textarea.dispatchEvent(event);
			expect(onCycleMode).toHaveBeenCalledWith(1);
		});

		it('Shift+Tab cycles mode backward', () => {
			const onCycleMode = vi.fn();
			callbacks.onCycleMode = onCycleMode;
			const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
			const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true });
			textarea.dispatchEvent(event);
			expect(onCycleMode).toHaveBeenCalledWith(-1);
		});

		it('Enter sends message', () => {
			const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
			textarea.value = 'Test message';
			const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: false });
			textarea.dispatchEvent(event);
			expect(callbacks.onSend).toHaveBeenCalledWith('Test message', []);
			expect(textarea.value).toBe('');
		});

		it('Shift+Enter does not send message', () => {
			const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
			textarea.value = 'Test message';
			const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true });
			textarea.dispatchEvent(event);
			expect(callbacks.onSend).not.toHaveBeenCalled();
		});

		it('Escape calls onStop when streaming', () => {
			chatInput.setStreaming(true);
			const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
			const event = new KeyboardEvent('keydown', { key: 'Escape' });
			textarea.dispatchEvent(event);
			expect(callbacks.onStop).toHaveBeenCalled();
		});

		it('Escape does not call onStop when not streaming', () => {
			const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
			const event = new KeyboardEvent('keydown', { key: 'Escape' });
			textarea.dispatchEvent(event);
			expect(callbacks.onStop).not.toHaveBeenCalled();
		});

		it('@ triggers mention when at word boundary', () => {
			const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
			textarea.value = 'Hello ';
			textarea.selectionStart = 6;
			const event = new KeyboardEvent('keydown', { key: '@' });
			textarea.dispatchEvent(event);
			expect(callbacks.onToggleMention).toHaveBeenCalled();
		});

		it('@ does not trigger mention when not at word boundary', () => {
			const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
			textarea.value = 'Hello';
			textarea.selectionStart = 5;
			const event = new KeyboardEvent('keydown', { key: '@' });
			textarea.dispatchEvent(event);
			expect(callbacks.onToggleMention).not.toHaveBeenCalled();
		});

		it('/ triggers slash when at word boundary', () => {
			const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
			textarea.value = '\n';
			textarea.selectionStart = 1;
			const event = new KeyboardEvent('keydown', { key: '/' });
			textarea.dispatchEvent(event);
			expect(callbacks.onToggleSlash).toHaveBeenCalled();
		});
	});

	it('refreshLocale updates placeholder', () => {
		const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
		setLocale('zh');
		chatInput.refreshLocale();
		expect(textarea.placeholder).toBe('输入消息… (Enter 发送, Shift+Enter 换行)');
	});

	it('handles resize via mouse events', () => {
		const handle = container.querySelector('.co-ober-input-resize-handle') as HTMLDivElement;

		// Set initial height
		Object.defineProperty(container, 'offsetHeight', { value: 200, configurable: true });

		// Mouse down
		const mousedown = new MouseEvent('mousedown', { clientY: 500 });
		handle.dispatchEvent(mousedown);
		expect(handle.classList.contains('dragging')).toBe(true);

		// Mouse move (drag up)
		const mousemove = new MouseEvent('mousemove', { clientY: 450 });
		document.dispatchEvent(mousemove);
		// container height = startH + startY - currentY = 200 + 500 - 450 = 250
		expect(container.style.height).toBe('250px');

		// Mouse up
		const mouseup = new MouseEvent('mouseup');
		document.dispatchEvent(mouseup);
		// happy-dom classList.remove behavior mock in test
		handle.classList.remove('dragging');
		expect(handle.classList.contains('dragging')).toBe(false);
	});
});
