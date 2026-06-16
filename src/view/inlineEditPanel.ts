import type { Editor } from 'obsidian';
import { t, onLocaleChange } from '../i18n/index';

export interface InlineEditState {
	original: string;
	editor: Editor;
}

export class InlineEditPanel {
	private el: HTMLDivElement | null = null;
	public pendingState: InlineEditState | null = null;

	constructor(private containerEl: HTMLElement) {
		onLocaleChange(() => this.refreshLocale());
	}

	request(selected: string, editor: Editor): string {
		this.clearState();
		this.pendingState = { original: selected, editor };
		return t().inlineEdit.prompt.replace('{text}', selected);
	}

	showDiffFromResponse(original: string, responseContent: string): void {
		this.showDiff(original, this.extractContent(responseContent));
	}

	showDiff(original: string, edited: string): void {
		this.hideDiff();
		const editor = this.pendingState?.editor;
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
		applyBtn.onclick = () => this.applyEdit(editor, edited);
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

	private applyEdit(editor: Editor | undefined, edited: string): void {
		if (!editor) return;
		editor.replaceSelection(edited);
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
