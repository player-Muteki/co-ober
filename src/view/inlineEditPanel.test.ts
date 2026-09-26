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
		const prompt = panel.request('text to edit', mockEditor, 'tab-1');

		expect(prompt).toBe('Please edit and improve the following text. Respond with ONLY the edited text, no explanations:\n\ntext to edit');
		expect(panel.pendingState).toEqual({
			original: 'text to edit',
			editor: mockEditor,
			tabId: 'tab-1',
		});
	});

	it('shows diff view with added and removed lines', () => {
		setLocale('en');
		const container = document.createElement('div');
		const panel = new InlineEditPanel(container);

		panel.showDiff('old text', 'new text');

		const el = container.querySelector('.co-ober-inline-edit-panel');
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
		panel.request('old text', mockEditor, 'tab-1');
		panel.showDiff('old text', 'new text');

		const applyBtn = container.querySelector('.co-ober-inline-edit-actions .mod-cta') as HTMLButtonElement;
		expect(applyBtn).not.toBeNull();
		applyBtn.click();

		expect(mockEditor.replaceSelection).toHaveBeenCalledWith('new text');
		expect(panel.pendingState).toBeNull();
		expect(container.querySelector('.co-ober-inline-edit-panel')).toBeNull();
	});

	it('discards edited text and clears state', () => {
		setLocale('en');
		const container = document.createElement('div');
		const panel = new InlineEditPanel(container);

		const mockEditor = { replaceSelection: vi.fn() } as any;
		panel.request('old text', mockEditor, 'tab-1');
		panel.showDiff('old text', 'new text');

		const discardBtn = container.querySelector('.co-ober-inline-edit-actions button:not(.mod-cta)') as HTMLButtonElement;
		expect(discardBtn).not.toBeNull();
		discardBtn.click();

		expect(mockEditor.replaceSelection).not.toHaveBeenCalled();
		expect(panel.pendingState).toBeNull();
		expect(container.querySelector('.co-ober-inline-edit-panel')).toBeNull();
	});

	it('keeps the tab that asked for the edit, and a second request replaces the first', () => {
		setLocale('en');
		const panel = new InlineEditPanel(document.createElement('div'));
		const editorA = { replaceSelection: vi.fn() } as any;
		const editorB = { replaceSelection: vi.fn() } as any;

		panel.request('selection A', editorA, 'tab-1');
		expect(panel.pendingState).toEqual({ original: 'selection A', editor: editorA, tabId: 'tab-1' });

		panel.request('selection B', editorB, 'tab-2');
		expect(panel.pendingState).toEqual({ original: 'selection B', editor: editorB, tabId: 'tab-2' });
	});

	it('paints a diff onto the editor it was handed, after the tab claimed the state', () => {
		setLocale('en');
		const container = document.createElement('div');
		const panel = new InlineEditPanel(container);
		const editor = { replaceSelection: vi.fn() } as any;

		// The send claims (and so clears) the pending state before the reply
		// arrives; the diff still has to know which selection to rewrite.
		panel.request('old text', editor, 'tab-1');
		panel.clearState();
		panel.showDiffFromResponse('old text', '```\nnew text\n```', editor);

		expect(container.querySelector('.diff-line.added')?.textContent).toBe('+new text');
		const applyBtn = container.querySelector('.co-ober-inline-edit-actions .mod-cta') as HTMLButtonElement;
		applyBtn.click();
		expect(editor.replaceSelection).toHaveBeenCalledWith('new text');
	});

	it('refreshes locale correctly', () => {
		setLocale('en');
		const container = document.createElement('div');
		const panel = new InlineEditPanel(container);

		panel.showDiff('old', 'new');

		let title = container.querySelector('.co-ober-inline-edit-title');
		let applyBtn = container.querySelector('.co-ober-inline-edit-actions .mod-cta');
		let discardBtn = container.querySelector('.co-ober-inline-edit-actions button:not(.mod-cta)');

		expect(title?.textContent).toBe('AI Edit Preview');
		expect(applyBtn?.textContent).toBe('Apply');
		expect(discardBtn?.textContent).toBe('Discard');

		setLocale('zh');
		panel.refreshLocale();

		title = container.querySelector('.co-ober-inline-edit-title');
		applyBtn = container.querySelector('.co-ober-inline-edit-actions .mod-cta');
		discardBtn = container.querySelector('.co-ober-inline-edit-actions button:not(.mod-cta)');

		expect(title?.textContent).toBe('AI 编辑预览');
		expect(applyBtn?.textContent).toBe('应用');
		expect(discardBtn?.textContent).toBe('放弃');
	});

	it('locale changes refresh a visible panel automatically; dispose() stops them', () => {
		setLocale('en');
		const container = document.createElement('div');
		const panel = new InlineEditPanel(container);
		panel.showDiff('old text', 'new text');

		const refreshSpy = vi.spyOn(panel, 'refreshLocale');
		setLocale('zh');
		expect(refreshSpy).toHaveBeenCalled();
		expect(container.querySelector('.co-ober-inline-edit-title')?.textContent).toBe('AI 编辑预览');

		refreshSpy.mockClear();
		panel.dispose();
		setLocale('en');
		expect(refreshSpy).not.toHaveBeenCalled();
		expect(container.querySelector('.co-ober-inline-edit-panel')).toBeNull();
	});
});
