import { Notice } from 'obsidian';
import type { SessionStore } from '../chat/session';
import { t } from '../i18n/index';
import { isImeComposing } from '../utils/ime';
import { humanizeError } from '../utils/errorText';
import type { AgentCapabilities, SessionMeta } from '../types';

const DELETE_CONFIRM_TIMEOUT_MS = 3000;

/**
 * Diff-summary badge for OpenCode-native rows; null when nothing was changed.
 * The row names all three figures or none: the reader's own store reports each
 * column separately, so a row that answered `additions` and said nothing about
 * files or deletions used to be shown as "0 files +7 -0" — a count of changed
 * files this client never read, and one that contradicts the +7 printed beside
 * it. A figure nobody reported is not a zero.
 */
export function nativeSummaryText(s: SessionMeta): string | null {
	const { files, additions, deletions } = s;
	if (files === undefined || additions === undefined || deletions === undefined) return null;
	if (files === 0 && additions === 0 && deletions === 0) return null;
	return t().sessionDropdown.summaryBadge
		.replace('{files}', String(files))
		.replace('{additions}', String(additions))
		.replace('{deletions}', String(deletions));
}

export interface SessionDropdownCallbacks {
	onSwitch(sessionId: string, source?: 'local' | 'opencode'): Promise<void>;
	onDelete(sessionId: string): Promise<void>;
	onNewSession(): Promise<void>;
	onFork?(sessionId: string): Promise<void>;
	onResume?(sessionId: string): Promise<void>;
	onRename?(sessionId: string, newTitle: string): Promise<void>;
	onTogglePin?(sessionId: string, pinned: boolean): Promise<void>;
}

export class SessionDropdown {
	private dropdownEl: HTMLDivElement | null = null;
	private outsideHandler: ((e: MouseEvent) => void) | null = null;
	/** Armed delete-confirm timers; must not fire after the dropdown closes. */
	private pendingDeleteTimers = new Set<number>();
	private doc: Document;
	private nativeSessions: SessionMeta[] = [];
	private nativeLoading = false;
	private nativeLoadedOnce = false;
	private nativeLoadError: string | null = null;
	private contentResults: SessionMeta[] = [];
	private contentSearchFailed = false;
	private searchToken = 0;
	/** Live title filter while open; survives mid-open rerenders, cleared on close. */
	private searchValue = '';

	constructor(
		private container: HTMLElement,
		private anchorEl: HTMLElement,
		private sessionStore: SessionStore,
		private getCurrentSessionId: () => string | null,
		private callbacks: SessionDropdownCallbacks,
		private getAgentCapabilities: () => AgentCapabilities | null = () => null,
		private loadNativeSessions: (() => Promise<SessionMeta[]>) | null = null,
		private searchNativeSessions: ((query: string) => Promise<SessionMeta[]>) | null = null,
	) {
		this.doc = container.ownerDocument ?? activeDocument;
	}

	open(): void {
		if (this.dropdownEl) {
			this.close();
			return;
		}
		this.contentResults = [];
		++this.searchToken;

		const capabilities = this.getAgentCapabilities()?.sessionCapabilities;
		const canList = capabilities?.list !== false;
		const list = this.getRenderableSessions(this.sessionStore.list(), canList);
		const dd = this.container.createDiv({ cls: 'co-ober-session-list' });

		const rect = this.anchorEl.getBoundingClientRect();
		dd.setCssProps({
			'--dropdown-top': `${rect.bottom + 4}px`,
			'--dropdown-right': `${Math.max(8, window.innerWidth - rect.right)}px`,
		});

		const searchInput = canList
			? dd.createEl('input', {
					cls: 'co-ober-session-search',
					attr: { placeholder: t().session.search, type: 'text' },
				})
			: null;
		if (searchInput && this.searchValue) searchInput.value = this.searchValue;

		const itemsContainer = dd.createDiv({ cls: 'co-ober-session-items' });
		itemsContainer.setAttribute('role', 'listbox');
		itemsContainer.setAttribute('aria-label', t().sessionDropdown.listboxAria);

		const renderItems = (filter: string) => {
			itemsContainer.empty();
			// Native and content sections are appended to dd, below the local
			// rows, so itemsContainer.empty() cannot reach them. Without this
			// sweep every keystroke leaves another stale copy behind.
			for (const el of Array.from(dd.children)) {
				if (el.classList.contains('co-ober-session-native-section') || el.classList.contains('co-ober-session-content-section')) el.remove();
			}
			const filtered = filter && canList
				? list.filter(s => s.title?.toLowerCase().includes(filter.toLowerCase()))
				: list;

			const currentId = this.getCurrentSessionId();
			for (const s of filtered) {
				const it = itemsContainer.createDiv({
					cls: `co-ober-session-item${s.sessionId === currentId ? ' active' : ''}`,
				});
				it.setAttribute('role', 'option');
				it.setAttribute('aria-selected', String(s.sessionId === currentId));
				it.createSpan({ text: s.title || s.sessionId, cls: 'session-label' });
				this.createActionButton(it, 'session-pin', s.pinned ? '★' : '☆', true, s.pinned ? t().sessionDropdown.unpin : t().sessionDropdown.pin, async () => {
					await this.callbacks.onTogglePin?.(s.sessionId, !(s.pinned === true));
					this.rerender();
				});
				this.createActionButton(it, 'session-rename', '✎', capabilities?.list !== false, capabilities?.list !== false ? t().sessionDropdown.rename : t().sessionDropdown.renameDisabled, async () => {
					this.startInlineRename(it, s);
				});
				this.createActionButton(it, 'session-fork', '⎇', capabilities?.fork === true, capabilities?.fork === true ? t().sessionDropdown.fork : t().sessionDropdown.forkDisabled, async () => {
					await this.callbacks.onFork?.(s.sessionId);
				});
				this.createActionButton(it, 'session-resume', '↻', capabilities?.resume === true, capabilities?.resume === true ? t().sessionDropdown.resume : t().sessionDropdown.resumeDisabled, async () => {
					await this.callbacks.onResume?.(s.sessionId);
				});
				this.createDeleteButton(it, s.sessionId, capabilities?.close === true);
				it.onclick = () => {
					void this.callbacks.onSwitch(s.sessionId, 'local').catch((e) => this.reportActionError(e));
				};
			}

			// "No sessions found" speaks for the whole dropdown, not just the local
			// rows: the native and content sections paint clickable sessions into
			// the panel below this line, so announcing nothing while listing them
			// contradicted the list the reader could see and act on. A still-loading
			// native fetch is not "nothing found" either.
			const wasLoadingNative = this.nativeLoading;
			const nativeRows = this.renderNativeSection(itemsContainer, currentId, filter);
			const contentRows = this.renderContentSection(itemsContainer, currentId, filter);
			if (filtered.length === 0 && nativeRows === 0 && contentRows === 0 && !wasLoadingNative) {
				itemsContainer.createDiv({
					cls: 'co-ober-session-empty',
					text: t().session.empty,
				});
			}
		};

		searchInput?.addEventListener('input', () => {
			const value = searchInput.value;
			this.searchValue = value;
			renderItems(value);
			void this.runContentSearch(value, () => renderItems(searchInput.value));
		});

		if (this.loadNativeSessions && !this.nativeLoadedOnce) {
			this.nativeLoading = true;
		}
		renderItems(this.searchValue);
		if (this.searchValue) void this.runContentSearch(this.searchValue, () => renderItems(this.searchValue));

		this.dropdownEl = dd;
		this.outsideHandler = (evt: MouseEvent) => {
			if (!this.dropdownEl) return;
			const target = evt.target as Node;
			if (this.dropdownEl.contains(target) || this.anchorEl.contains(target)) return;
			this.close();
		};
		this.doc.addEventListener('mousedown', this.outsideHandler, true);
	}

	private renderNativeSection(itemsContainer: HTMLElement, currentId: string | null, filter: string): number {
		if (!this.loadNativeSessions) return 0;
		const dd = itemsContainer.parentElement;
		if (!dd) return 0;

		const localIds = new Set(this.sessionStore.list().map((s) => s.sessionId));
		const native = this.nativeSessions.filter((s) => !localIds.has(s.sessionId));
		const filteredNative = filter
			? native.filter((s) => s.title?.toLowerCase().includes(filter.toLowerCase()))
			: native;

		if (this.nativeLoading) {
			const loadingSection = dd.createDiv({ cls: 'co-ober-session-native-section' });
			loadingSection.createDiv({ cls: 'co-ober-session-native-loading', text: t().sessionDropdown.loadingNative });
			this.nativeLoading = false;
			void this.loadNativeSessions().then((sessions) => {
				this.nativeSessions = sessions;
				this.nativeLoadedOnce = true;
				this.nativeLoadError = null;
				if (!this.dropdownEl) return;
				this.rerender();
			}).catch((e: unknown) => {
				this.nativeLoadedOnce = true;
				this.nativeLoadError = humanizeError(e);
				console.error('[co-ober] native session list failed:', e);
				if (this.dropdownEl) this.rerender();
			});
			return 0;
		}
		if (this.nativeLoadError) {
			itemsContainer.createDiv({ cls: 'co-ober-session-native-error', text: t().sessionDropdown.nativeError });
		}
		if (filteredNative.length === 0) return 0;

		const section = dd.createDiv({ cls: 'co-ober-session-native-section' });
		section.createDiv({ cls: 'co-ober-session-native-header', text: t().sessionDropdown.nativeSection });
		const nativeList = section.createDiv({ cls: 'co-ober-session-native-items' });
		for (const s of filteredNative) {
			const it = nativeList.createDiv({
				cls: `co-ober-session-item co-ober-session-native${s.sessionId === currentId ? ' active' : ''}`,
			});
			it.createSpan({ text: s.title || s.sessionId, cls: 'session-label' });
			const summary = nativeSummaryText(s);
			if (summary) it.createSpan({ cls: 'session-summary', text: summary });
			if (s.updatedAt) {
				it.createSpan({ cls: 'session-time', text: this.formatSessionDate(s.updatedAt) });
			}
			it.onclick = () => {
				void this.callbacks.onSwitch(s.sessionId, 'opencode').catch((e) => this.reportActionError(e));
			};
		}
		return filteredNative.length;
	}

	private rerender(opts?: { force?: boolean }): void {
		// Async refreshes (native list, pin toggle) must not tear down an
		// in-progress rename; the rename's own settle forces the rebuild.
		if (!opts?.force && this.dropdownEl?.querySelector('.session-rename-input')) return;
		const filter = this.searchValue;
		// The rebuild throws away the input the reader is typing into. A pin
		// toggle, or the native list simply arriving, used to drop the caret onto
		// the document with the box still showing the text — so every keystroke
		// after it went nowhere and the panel looked frozen.
		const before = this.dropdownEl?.querySelector<HTMLInputElement>('.co-ober-session-search');
		const caret = before && before === this.doc.activeElement ? before.selectionStart ?? filter.length : -1;
		this.close();
		this.searchValue = filter;
		this.open();
		if (caret < 0) return;
		const after = this.dropdownEl?.querySelector<HTMLInputElement>('.co-ober-session-search');
		if (!after) return;
		after.focus();
		after.setSelectionRange(caret, caret);
	}

	private async runContentSearch(query: string, onSettled: () => void): Promise<void> {
		const trimmed = query.trim();
		this.contentSearchFailed = false;
		if (!this.searchNativeSessions || trimmed.length < 2) {
			this.contentResults = [];
			return;
		}
		const token = ++this.searchToken;
		try {
			const results = await this.searchNativeSessions(trimmed);
			if (token !== this.searchToken) return;
			this.contentResults = results;
			onSettled();
		} catch (e) {
			console.warn('[co-ober] native session search failed:', e);
			if (token !== this.searchToken) return;
			this.contentResults = [];
			this.contentSearchFailed = true;
			onSettled();
		}
	}

	private renderContentSection(itemsContainer: HTMLElement, currentId: string | null, filter: string): number {
		if (!this.searchNativeSessions || filter.trim().length < 2) return 0;
		const dd = itemsContainer.parentElement;
		if (!dd) return 0;
		if (this.contentSearchFailed) {
			// A silent console warning leaves the user believing there are no
			// matches; say out loud that the search itself failed.
			itemsContainer.createDiv({ cls: 'co-ober-session-native-error', text: t().sessionDropdown.contentError });
			return 0;
		}
		if (this.contentResults.length === 0) return 0;

		const listed = new Set([
			...this.sessionStore.list().map((s) => s.sessionId),
			...this.nativeSessions.map((s) => s.sessionId),
		]);
		const extra = this.contentResults.filter((s) => !listed.has(s.sessionId));
		if (extra.length === 0) return 0;

		const section = dd.createDiv({ cls: 'co-ober-session-content-section' });
		section.createDiv({ cls: 'co-ober-session-native-header', text: t().sessionDropdown.contentSection });
		const list = section.createDiv({ cls: 'co-ober-session-native-items' });
		for (const s of extra) {
			const it = list.createDiv({
				cls: `co-ober-session-item co-ober-session-content${s.sessionId === currentId ? ' active' : ''}`,
			});
			it.createSpan({ text: s.title || s.sessionId, cls: 'session-label' });
			if (s.updatedAt) it.createSpan({ cls: 'session-time', text: this.formatSessionDate(s.updatedAt) });
			if (s.snippet) it.createDiv({ cls: 'session-snippet', text: s.snippet.trim() });
			it.onclick = () => {
				void this.callbacks.onSwitch(s.sessionId, 'opencode').catch((e) => this.reportActionError(e));
			};
		}
		return extra.length;
	}

	close(): void {
		this.searchValue = '';
		for (const timer of this.pendingDeleteTimers) window.clearTimeout(timer);
		this.pendingDeleteTimers.clear();
		if (this.dropdownEl) {
			this.dropdownEl.remove();
			this.dropdownEl = null;
		}
		if (this.outsideHandler) {
			this.doc.removeEventListener('mousedown', this.outsideHandler, true);
			this.outsideHandler = null;
		}
	}

	isOpen(): boolean {
		return this.dropdownEl !== null;
	}

	destroy(): void {
		this.close();
	}

	private getRenderableSessions(list: SessionMeta[], canList: boolean): SessionMeta[] {
		if (canList) return list;
		const currentId = this.getCurrentSessionId();
		if (!currentId) return [];
		const current = list.filter((session) => session.sessionId === currentId).slice(0, 1);
		return current.length > 0 ? current : [{ sessionId: currentId, title: currentId }];
	}

	/** `title` labels the button in both states: why it works, or why it cannot. */
	private createActionButton(container: HTMLElement, cls: string, text: string, enabled: boolean, title: string, onClick: () => Promise<void>): void {
		const button = container.createEl('button', { text, cls });
		button.setAttribute('title', title);
		button.setAttribute('aria-label', title);
		if (!enabled) {
			button.disabled = true;
			button.addClass('is-disabled');
			return;
		}
		button.onclick = (e: MouseEvent) => {
			e.stopPropagation();
			void onClick().catch((err) => this.reportActionError(err));
		};
	}

	/** Delete needs a second confirming click; a timeout reverts to the armed-off state. */
	private createDeleteButton(container: HTMLElement, sessionId: string, enabled: boolean): void {
		const button = container.createEl('button', { text: '×', cls: 'session-delete' });
		button.setAttribute('aria-label', t().sessionDropdown.delete);
		if (!enabled) {
			button.disabled = true;
			button.addClass('is-disabled');
			button.setAttribute('title', t().sessionDropdown.closeDisabled);
			button.setAttribute('aria-label', t().sessionDropdown.closeDisabled);
			return;
		}
		let confirmTimer: number | null = null;
		const reset = (): void => {
			if (confirmTimer !== null) {
				window.clearTimeout(confirmTimer);
				this.pendingDeleteTimers.delete(confirmTimer);
				confirmTimer = null;
			}
			button.classList.remove('is-confirm');
			button.textContent = '×';
			button.setAttribute('aria-label', t().sessionDropdown.delete);
			button.removeAttribute('title');
		};
		button.onclick = (e: MouseEvent) => {
			e.stopPropagation();
			if (!button.classList.contains('is-confirm')) {
				button.classList.add('is-confirm');
				button.textContent = '✓';
				button.setAttribute('title', t().sessionDropdown.confirmDelete);
				button.setAttribute('aria-label', t().sessionDropdown.confirmDelete);
				confirmTimer = window.setTimeout(reset, DELETE_CONFIRM_TIMEOUT_MS);
				this.pendingDeleteTimers.add(confirmTimer);
				return;
			}
			reset();
			void this.callbacks.onDelete(sessionId)
				.then(() => this.close())
				.catch((err) => this.reportActionError(err));
		};
	}

	private startInlineRename(item: HTMLElement, session: SessionMeta): void {
		if (item.querySelector('.session-rename-input')) return;
		const label = item.querySelector('.session-label');
		if (!label) return;
		const original = session.title || session.sessionId;
		const input = item.createEl('input', {
			cls: 'session-rename-input',
			attr: { type: 'text', 'aria-label': t().sessionDropdown.renameInput },
		});
		label.replaceWith(input);
		input.value = original;
		input.focus();
		input.select();
		let settled = false;
		const commit = async (): Promise<void> => {
			if (settled) return;
			settled = true;
			const value = input.value.trim();
			if (value && value !== original) {
				await this.callbacks.onRename?.(session.sessionId, value);
			}
			this.rerender({ force: true });
		};
		const cancel = (): void => {
			if (settled) return;
			settled = true;
			this.rerender({ force: true });
		};
		input.addEventListener('keydown', (e: KeyboardEvent) => {
			// Enter/Escape mid-composition are IME candidate keys, not commit/cancel.
			if (isImeComposing(e)) return;
			if (e.key === 'Enter') {
				e.preventDefault();
				e.stopPropagation();
				void commit().catch((err) => this.reportActionError(err));
			} else if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				cancel();
			}
		});
		// Keep clicks/typing inside the input from switching or closing the dropdown.
		input.onclick = (e: MouseEvent) => e.stopPropagation();
		input.onmousedown = (e: MouseEvent) => e.stopPropagation();
		input.addEventListener('blur', () => {
			void commit().catch((err) => this.reportActionError(err));
		});
	}

	/** Render an ISO timestamp as a locale date; keep the raw prefix if unparsable. */
	private formatSessionDate(iso: string): string {
		const date = new Date(iso);
		return Number.isNaN(date.getTime()) ? iso.slice(0, 10) : date.toLocaleDateString();
	}

	private reportActionError(e: unknown): void {
		console.error('[co-ober] session action:', e);
		new Notice(t().sessionDropdown.actionFailed.replace('{error}', humanizeError(e)));
	}
}
