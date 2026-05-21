import type { SessionStore } from '../chat/session';
import { t } from '../i18n/index';

export interface SessionDropdownCallbacks {
	onSwitch(sessionId: string): Promise<void>;
	onDelete(sessionId: string): Promise<void>;
	onNewSession(): Promise<void>;
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
	) {}

	open(): void {
		if (this.dropdownEl) {
			this.close();
			return;
		}

		const list = this.sessionStore.list();
		const dd = this.container.createDiv({ cls: 'copsidian-session-list' });

		const rect = this.anchorEl.getBoundingClientRect();
		dd.style.position = 'fixed';
		dd.style.top = `${rect.bottom + 4}px`;
		dd.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;

		const searchInput = dd.createEl('input', {
			cls: 'copsidian-session-search',
			attr: { placeholder: t().session.search, type: 'text' },
		});

		const itemsContainer = dd.createDiv({ cls: 'copsidian-session-items' });

		const renderItems = (filter: string) => {
			itemsContainer.empty();
			const filtered = filter
				? list.filter(s => s.title?.toLowerCase().includes(filter.toLowerCase()))
				: list;

			if (filtered.length === 0) {
				itemsContainer.createDiv({
					cls: 'copsidian-session-empty',
					text: t().session.empty,
				});
				return;
			}

			const currentId = this.getCurrentSessionId();
			for (const s of filtered) {
				const it = itemsContainer.createDiv({
					cls: `copsidian-session-item${s.sessionId === currentId ? ' active' : ''}`,
				});
				it.createSpan({ text: s.title || s.sessionId, cls: 'session-label' });
				const delBtn = it.createSpan({ text: '×', cls: 'session-delete' });
				delBtn.onclick = async (e: MouseEvent) => {
					e.stopPropagation();
					this.sessionStore.remove(s.sessionId);
					await this.sessionStore.save();
					if (s.sessionId === currentId) {
						await this.callbacks.onNewSession();
					}
					this.close();
				};
				it.onclick = async () => {
					await this.callbacks.onSwitch(s.sessionId);
				};
			}
		};

		searchInput.addEventListener('input', () => {
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
}
