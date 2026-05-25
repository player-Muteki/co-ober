// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { InlineEditPanel } from './inlineEditPanel';
import { installObsidianDomHelpers } from '../test/domHelpers';
import { setLocale } from '../i18n';

installObsidianDomHelpers();

describe('InlineEditPanel', () => {
	it('requests properly and returns correct prompt', () => {
		setLocale('en');
		const container = document.createElement('div');
		const panel = new InlineEditPanel(container);

		const mockEditor = { replaceSelection: vi.fn() } as any;
		const prompt = panel.request('text to edit', mockEditor);

		expect(prompt).toBe('Please edit and improve the following text. Respond with ONLY the edited text, no explanations:\n\ntext to edit');
		expect(panel.pendingState).toEqual({
			original: 'text to edit',
			editor: mockEditor,
		});
	});

	it('shows diff view with added and removed lines', () => {
		setLocale('en');
		const container = document.createElement('div');
		const panel = new InlineEditPanel(container);

		panel.showDiff('old text', 'new text');

		const el = container.querySelector('.copsidian-inline-edit-panel');
		expect(el).not.toBeNull();

		const removed = el?.querySelectorAll('.diff-line.removed');
		const added = el?.querySelectorAll('.diff-line.added');

		expect(removed?.length).toBe(1);
		expect(removed?.[0].textContent).toBe('-old text');

		expect(added?.length).toBe(1);
		expect(added?.[0].textContent).toBe('+new text');
	});

	it('applies edited text and clears state', () => {
		setLocale('en');
		const container = document.createElement('div');
		const panel = new InlineEditPanel(container);

		const mockEditor = { replaceSelection: vi.fn() } as any;
		panel.request('old text', mockEditor);
		panel.showDiff('old text', 'new text');

		const applyBtn = container.querySelector('.copsidian-inline-edit-actions .mod-cta') as HTMLButtonElement;
		expect(applyBtn).not.toBeNull();
		applyBtn.click();

		expect(mockEditor.replaceSelection).toHaveBeenCalledWith('new text');
		expect(panel.pendingState).toBeNull();
		expect(container.querySelector('.copsidian-inline-edit-panel')).toBeNull();
	});

	it('discards edited text and clears state', () => {
		setLocale('en');
		const container = document.createElement('div');
		const panel = new InlineEditPanel(container);

		const mockEditor = { replaceSelection: vi.fn() } as any;
		panel.request('old text', mockEditor);
		panel.showDiff('old text', 'new text');

		const discardBtn = container.querySelector('.copsidian-inline-edit-actions button:not(.mod-cta)') as HTMLButtonElement;
		expect(discardBtn).not.toBeNull();
		discardBtn.click();

		expect(mockEditor.replaceSelection).not.toHaveBeenCalled();
		expect(panel.pendingState).toBeNull();
		expect(container.querySelector('.copsidian-inline-edit-panel')).toBeNull();
	});

	it('refreshes locale correctly', () => {
		setLocale('en');
		const container = document.createElement('div');
		const panel = new InlineEditPanel(container);

		panel.showDiff('old', 'new');

		let title = container.querySelector('.copsidian-inline-edit-title');
		let applyBtn = container.querySelector('.copsidian-inline-edit-actions .mod-cta');
		let discardBtn = container.querySelector('.copsidian-inline-edit-actions button:not(.mod-cta)');

		expect(title?.textContent).toBe('AI Edit Preview');
		expect(applyBtn?.textContent).toBe('Apply');
		expect(discardBtn?.textContent).toBe('Discard');

		setLocale('zh');
		panel.refreshLocale();

		title = container.querySelector('.copsidian-inline-edit-title');
		applyBtn = container.querySelector('.copsidian-inline-edit-actions .mod-cta');
		discardBtn = container.querySelector('.copsidian-inline-edit-actions button:not(.mod-cta)');

		expect(title?.textContent).toBe('AI 编辑预览');
		expect(applyBtn?.textContent).toBe('应用');
		expect(discardBtn?.textContent).toBe('放弃');
	});
});
