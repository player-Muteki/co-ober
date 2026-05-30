import type { SessionStore } from '../chat/session';
import { t } from '../i18n/index';
import type { AgentCapabilities, SessionMeta } from '../types';

export interface SessionDropdownCallbacks {
	onSwitch(sessionId: string): Promise<void>;
	onDelete(sessionId: string): Promise<void>;
	onNewSession(): Promise<void>;
	onFork?(sessionId: string): Promise<void>;
	onResume?(sessionId: string): Promise<void>;
}

export class SessionDropdown {
	private dropdownEl: HTMLDivElement | null = null;
	private outsideHandler: ((e: MouseEvent) => void) | null = null;

	constructor(
		private container: HTMLElement,
		private anchorEl: HTMLElement,
		private sessionStore: SessionStore,
		private getCurrentSessionId: () => string | null,
		private callbacks: SessionDropdownCallbacks,
		private getAgentCapabilities: () => AgentCapabilities | null = () => null,
	) {}

	open(): void {
		if (this.dropdownEl) {
			this.close();
			return;
		}

		const capabilities = this.getAgentCapabilities()?.sessionCapabilities;
		const canList = capabilities?.list !== false;
		const list = this.getRenderableSessions(this.sessionStore.list(), canList);
		const dd = this.container.createDiv({ cls: 'copsilot-session-list' });

		const rect = this.anchorEl.getBoundingClientRect();
		dd.style.position = 'fixed';
		dd.style.top = `${rect.bottom + 4}px`;
		dd.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;

		const searchInput = canList
			? dd.createEl('input', {
				cls: 'copsilot-session-search',
				attr: { placeholder: t().session.search, type: 'text' },
			})
			: null;

		const itemsContainer = dd.createDiv({ cls: 'copsilot-session-items' });

		const renderItems = (filter: string) => {
			itemsContainer.empty();
			const filtered = filter && canList
				? list.filter(s => s.title?.toLowerCase().includes(filter.toLowerCase()))
				: list;

			if (filtered.length === 0) {
				itemsContainer.createDiv({
					cls: 'copsilot-session-empty',
					text: t().session.empty,
				});
				return;
			}

			const currentId = this.getCurrentSessionId();
			for (const s of filtered) {
				const it = itemsContainer.createDiv({
					cls: `copsilot-session-item${s.sessionId === currentId ? ' active' : ''}`,
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
				it.onclick = async () => {
					await this.callbacks.onSwitch(s.sessionId);
				};
			}
		};

		searchInput?.addEventListener('input', () => {
			renderItems(searchInput.value);
		});

		renderItems('');

		this.dropdownEl = dd;
		this.outsideHandler = (evt: MouseEvent) => {
			if (!this.dropdownEl) return;
			const target = evt.target as Node;
			if (this.dropdownEl.contains(target) || this.anchorEl.contains(target)) return;
			this.close();
		};
		document.addEventListener('mousedown', this.outsideHandler, true);
	}

	close(): void {
		if (this.dropdownEl) {
			this.dropdownEl.remove();
			this.dropdownEl = null;
		}
		if (this.outsideHandler) {
			document.removeEventListener('mousedown', this.outsideHandler, true);
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
		button.onclick = async (e: MouseEvent) => {
			e.stopPropagation();
			await onClick();
		};
	}
}
