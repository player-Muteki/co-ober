import type { Editor, EditorPosition } from 'obsidian';
import { Notice } from 'obsidian';
import { t, onLocaleChange } from '../i18n/index';

/** Where the selection lived when the edit was asked for. */
export interface InlineEditRange {
  from: EditorPosition;
  to: EditorPosition;
}

export interface InlineEditState {
	original: string;
	editor: Editor;
	// The conversation that asked for the edit. Its reply is the only one that
	// may be painted over the selection; any other tab's send would show an
	// unrelated answer here, and its Apply would rewrite this tab's text.
	tabId: string;
	/** Captured with `original`, so Apply can still find that text. */
	range?: InlineEditRange;
}

/**
 * The range `selected` was read from, when the editor will say. Comparing the
 * text at those positions against `selected` is what makes the answer usable:
 * a range that no longer holds that text is not the selection this edit is for.
 */
function selectionRange(editor: Editor, selected: string): InlineEditRange | undefined {
  const selection = editor.listSelections?.()[0];
  if (!selection) return undefined;
  const { anchor, head } = selection;
  const forward = anchor.line < head.line || (anchor.line === head.line && anchor.ch <= head.ch);
  const range = { from: forward ? anchor : head, to: forward ? head : anchor };
  if (typeof editor.getRange === 'function' && editor.getRange(range.from, range.to) !== selected) return undefined;
  return range;
}

export class InlineEditPanel {
	private el: HTMLDivElement | null = null;
	public pendingState: InlineEditState | null = null;
	private unsubscribeLocale: () => void;

	constructor(private containerEl: HTMLElement) {
		this.unsubscribeLocale = onLocaleChange(() => this.refreshLocale());
	}

	dispose(): void {
		this.unsubscribeLocale();
		this.clearState();
	}

	request(selected: string, editor: Editor, tabId: string): string {
		this.clearState();
		this.pendingState = { original: selected, editor, tabId, range: selectionRange(editor, selected) };
		return t().inlineEdit.prompt.replace('{text}', selected);
	}

	showDiffFromResponse(original: string, responseContent: string, editor?: Editor, range?: InlineEditRange): void {
		this.showDiff(original, this.extractContent(responseContent), editor, range);
	}

	showDiff(
		original: string,
		edited: string,
		editor: Editor | undefined = this.pendingState?.editor,
		range?: InlineEditRange,
	): void {
		// A range is only usable with the editor it was read out of, so an
		// explicitly handed editor falls back to the pending state's own range
		// and a stranger editor gets none.
		const target = editor ?? this.pendingState?.editor;
		const targetRange = range ?? (target && target === this.pendingState?.editor ? this.pendingState?.range : undefined);
		this.hideDiff();
		const panel = this.containerEl.createDiv({ cls: 'co-ober-inline-edit-panel' });
		this.el = panel;

		panel.createDiv({ cls: 'co-ober-inline-edit-title', text: t().inlineEdit.title });

		const diffBody = panel.createDiv({ cls: 'co-ober-diff-body' });
		const oldLines = original.split('\n');
		const newLines = edited.split('\n');
		const maxLen = Math.max(oldLines.length, newLines.length);
		for (let i = 0; i < maxLen; i++) {
			const oldLine = oldLines[i];
			const newLine = newLines[i];
			if (oldLine === undefined) {
				const line = diffBody.createDiv({ cls: 'diff-line added' });
				line.createSpan({ cls: 'diff-marker', text: '+' });
				line.createSpan({ text: newLine });
			} else if (newLine === undefined) {
				const line = diffBody.createDiv({ cls: 'diff-line removed' });
				line.createSpan({ cls: 'diff-marker', text: '-' });
				line.createSpan({ text: oldLine });
			} else if (oldLine !== newLine) {
				const rmLine = diffBody.createDiv({ cls: 'diff-line removed' });
				rmLine.createSpan({ cls: 'diff-marker', text: '-' });
				rmLine.createSpan({ text: oldLine });
				const addLine = diffBody.createDiv({ cls: 'diff-line added' });
				addLine.createSpan({ cls: 'diff-marker', text: '+' });
				addLine.createSpan({ text: newLine });
			} else {
				const line = diffBody.createDiv({ cls: 'diff-line context' });
				line.createSpan({ cls: 'diff-marker', text: ' ' });
				line.createSpan({ text: oldLine });
			}
		}

		const actions = panel.createDiv({ cls: 'co-ober-inline-edit-actions' });
		const applyBtn = actions.createEl('button', { cls: 'mod-cta', text: t().inlineEdit.apply });
		applyBtn.onclick = () => this.applyEdit(target, edited, original, targetRange);
		const discardBtn = actions.createEl('button', { text: t().inlineEdit.discard });
		discardBtn.onclick = () => this.clearState();
	}

	refreshLocale(): void {
		if (!this.el) return;
		const title = this.el.querySelector('.co-ober-inline-edit-title');
		if (title) title.textContent = t().inlineEdit.title;
		const apply = this.el.querySelector('.co-ober-inline-edit-actions .mod-cta');
		if (apply) apply.textContent = t().inlineEdit.apply;
		const buttons = this.el.querySelectorAll('.co-ober-inline-edit-actions button');
		const discard = buttons[1];
		if (discard) discard.textContent = t().inlineEdit.discard;
	}

	private applyEdit(editor: Editor | undefined, edited: string, original: string, range?: InlineEditRange): void {
		if (!editor) return;
		if (!range || typeof editor.getRange !== 'function' || typeof editor.replaceRange !== 'function') {
			editor.replaceSelection(edited);
			this.clearState();
			return;
		}
		// The reply answers the text that was selected when it was asked for.
		// Writing it wherever the cursor has drifted to in the meantime would
		// rewrite a paragraph the user never asked about, so the edit is
		// refused instead — visibly.
		if (editor.getRange(range.from, range.to) !== original) {
			new Notice(t().inlineEdit.selectionMoved);
			return;
		}
		editor.replaceRange(edited, range.from, range.to);
		this.clearState();
	}

	clearState(): void {
		this.pendingState = null;
		this.hideDiff();
	}

	private hideDiff(): void {
		if (this.el) {
			this.el.remove();
			this.el = null;
		}
	}

	private extractContent(content: string): string {
		const trimmed = content.trim();
		const fenceMatch = trimmed.match(/^```[\w-]*\n([\s\S]*?)\n```$/);
		if (fenceMatch) return fenceMatch[1];
		const blocks = trimmed.match(/```[\w-]*\n([\s\S]*?)\n```/g);
		if (blocks && blocks.length === 1) {
			const inner = blocks[0].match(/^```[\w-]*\n([\s\S]*?)\n```$/);
			if (inner) return inner[1];
		}
		return content;
	}
}
