import { Notice } from 'obsidian';
import type { SessionStore } from '../chat/session';
import { t } from '../i18n/index';
import type { AgentCapabilities, SessionMeta } from '../types';

export interface SessionDropdownCallbacks {
	onSwitch(sessionId: string, source?: 'local' | 'opencode'): Promise<void>;
	onDelete(sessionId: string): Promise<void>;
	onNewSession(): Promise<void>;
	onFork?(sessionId: string): Promise<void>;
	onResume?(sessionId: string): Promise<void>;
}

export class SessionDropdown {
	private dropdownEl: HTMLDivElement | null = null;
	private outsideHandler: ((e: MouseEvent) => void) | null = null;
	private doc: Document;
	private nativeSessions: SessionMeta[] = [];
	private nativeLoading = false;
	private nativeLoadedOnce = false;

	constructor(
		private container: HTMLElement,
		private anchorEl: HTMLElement,
		private sessionStore: SessionStore,
		private getCurrentSessionId: () => string | null,
		private callbacks: SessionDropdownCallbacks,
		private getAgentCapabilities: () => AgentCapabilities | null = () => null,
		private loadNativeSessions: (() => Promise<SessionMeta[]>) | null = null,
	) {
		this.doc = container.ownerDocument ?? activeDocument;
	}

	open(): void {
		if (this.dropdownEl) {
			this.close();
			return;
		}

		const capabilities = this.getAgentCapabilities()?.sessionCapabilities;
		const canList = capabilities?.list !== false;
		const list = this.getRenderableSessions(this.sessionStore.list(), canList);
		const dd = this.container.createDiv({ cls: 'co-ober-session-list' });

		const rect = this.anchorEl.getBoundingClientRect();
		dd.setCssProps({
			'--dropdown-top': `${rect.bottom + 4}px`,
			'--dropdown-right': `${Math.max(8, window.innerWidth - rect.right)}px`,
		});

		const searchInput = canList			? dd.createEl('input', {
				cls: 'co-ober-session-search',
				attr: { placeholder: t().session.search, type: 'text' },
			})
			: null;

		const itemsContainer = dd.createDiv({ cls: 'co-ober-session-items' });

		const renderItems = (filter: string) => {
			itemsContainer.empty();
			const filtered = filter && canList
				? list.filter(s => s.title?.toLowerCase().includes(filter.toLowerCase()))
				: list;

			if (filtered.length === 0) {
				itemsContainer.createDiv({
					cls: 'co-ober-session-empty',
					text: t().session.empty,
				});
			}

			const currentId = this.getCurrentSessionId();
			for (const s of filtered) {
				const it = itemsContainer.createDiv({
					cls: `co-ober-session-item${s.sessionId === currentId ? ' active' : ''}`,
				});
				it.createSpan({ text: s.title || s.sessionId, cls: 'session-label' });
				this.createActionButton(it, 'session-fork', '⎇', capabilities?.fork === true, t().sessionDropdown.forkDisabled, async () => {
					await this.callbacks.onFork?.(s.sessionId);
				});
				this.createActionButton(it, 'session-resume', '↻', capabilities?.resume === true, t().sessionDropdown.resumeDisabled, async () => {
					await this.callbacks.onResume?.(s.sessionId);
				});
				this.createActionButton(it, 'session-delete', '×', capabilities?.close === true, t().sessionDropdown.closeDisabled, async () => {
					await this.callbacks.onDelete(s.sessionId);
					this.close();
				});
				it.onclick = () => {
					void this.callbacks.onSwitch(s.sessionId, 'local').catch((e) => this.reportActionError(e));
				};
			}

			this.renderNativeSection(itemsContainer, currentId, filter);
		};

		searchInput?.addEventListener('input', () => {
			renderItems(searchInput.value);
		});

		if (this.loadNativeSessions && !this.nativeLoadedOnce) {
			this.nativeLoading = true;
		}
		renderItems('');

		this.dropdownEl = dd;
		this.outsideHandler = (evt: MouseEvent) => {
			if (!this.dropdownEl) return;
			const target = evt.target as Node;
			if (this.dropdownEl.contains(target) || this.anchorEl.contains(target)) return;
			this.close();
		};
		this.doc.addEventListener('mousedown', this.outsideHandler, true);
	}

	private renderNativeSection(itemsContainer: HTMLElement, currentId: string | null, filter: string): void {
		if (!this.loadNativeSessions) return;
		const dd = itemsContainer.parentElement;
		if (!dd) return;

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
				if (!this.dropdownEl) return;
				this.rerender();
			}).catch(() => {
				this.nativeLoadedOnce = true;
				if (this.dropdownEl) this.rerender();
			});
			return;
		}
		if (filteredNative.length === 0) return;

		const section = dd.createDiv({ cls: 'co-ober-session-native-section' });
		section.createDiv({ cls: 'co-ober-session-native-header', text: t().sessionDropdown.nativeSection });
		const nativeList = section.createDiv({ cls: 'co-ober-session-native-items' });
		for (const s of filteredNative) {
			const it = nativeList.createDiv({
				cls: `co-ober-session-item co-ober-session-native${s.sessionId === currentId ? ' active' : ''}`,
			});
			it.createSpan({ text: s.title || s.sessionId, cls: 'session-label' });
			if (s.updatedAt) {
				it.createSpan({ cls: 'session-time', text: s.updatedAt.slice(0, 10) });
			}
			it.onclick = () => {
				void this.callbacks.onSwitch(s.sessionId, 'opencode').catch((e) => this.reportActionError(e));
			};
		}
	}

	private rerender(): void {
		// Re-open rendering by simulating a close/open is too disruptive; instead
		// rebuild the items container content via a fresh open cycle on next toggle.
		this.close();
		this.open();
	}

	close(): void {
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

	private createActionButton(container: HTMLElement, cls: string, text: string, enabled: boolean, disabledTitle: string, onClick: () => Promise<void>): void {
		const button = container.createEl('button', { text, cls });
		if (!enabled) {
			button.disabled = true;
			button.addClass('is-disabled');
			button.setAttribute('title', disabledTitle);
			return;
		}
		button.onclick = (e: MouseEvent) => {
			e.stopPropagation();
			void onClick().catch((err) => this.reportActionError(err));
		};
	}

	private reportActionError(e: unknown): void {
		console.error('[co-ober] session action:', e);
		new Notice(t().sessionDropdown.actionFailed.replace('{error}', e instanceof Error ? e.message : String(e)));
	}
}
