import { t } from '../i18n/index';

export interface ACItem {
	value: string;
	label: string;
	description?: string;
}

export interface AutocompleteCallbacks {
	onSelect(value: string, mode: '@' | '/'): void;
}

export class Autocomplete {
	private dropdownEl: HTMLDivElement | null = null;
	private outsideHandler: ((e: MouseEvent) => void) | null = null;
	private keyHandler: ((e: KeyboardEvent) => void) | null = null;

	constructor(
		private container: HTMLElement,
		private callbacks: AutocompleteCallbacks,
	) {}

	open(items: ACItem[], mode: '@' | '/'): void {
		this.close();

		const ac = this.container.createDiv({ cls: 'copsidian-ac-dropdown' });
		this.dropdownEl = ac;

		let selIdx = 0;
		let filterText = '';
		let filtered = items;

		const applyFilter = () => {
			if (!filterText) {
				filtered = items;
			} else {
				const lower = filterText.toLowerCase();
				filtered = items.filter(it => it.label.toLowerCase().includes(lower) || it.description?.toLowerCase().includes(lower));
			}
			selIdx = 0;
		};

		const render = () => {
			ac.empty();
			if (filtered.length === 0) {
				ac.createDiv({ cls: 'copsidian-ac-item', text: t().autocomplete.noMatches });
				return;
			}
			for (let i = 0; i < filtered.length; i++) {
				const el = ac.createDiv({ cls: `copsidian-ac-item${i === selIdx ? ' selected' : ''}` });
				el.createSpan({ text: filtered[i].label, cls: 'ac-label' });
				if (filtered[i].description) el.createSpan({ text: filtered[i].description, cls: 'ac-desc' });
				el.onclick = () => {
					this.callbacks.onSelect(filtered[i].value, mode);
				};
			}
		};
		render();

		this.keyHandler = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				this.close();
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			if (e.key === 'ArrowDown') {
				selIdx = (selIdx + 1) % Math.max(1, filtered.length);
				render();
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			if (e.key === 'ArrowUp') {
				selIdx = (selIdx - 1 + filtered.length) % Math.max(1, filtered.length);
				render();
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			if (e.key === 'Enter') {
				if (filtered.length > 0) {
					this.callbacks.onSelect(filtered[selIdx].value, mode);
				}
				this.close();
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			if (e.key === 'Backspace') {
				if (filterText.length > 0) {
					e.preventDefault();
					e.stopPropagation();
					filterText = filterText.slice(0, -1);
					applyFilter();
					render();
				} else {
					this.close();
					e.preventDefault();
					e.stopPropagation();
				}
				return;
			}
			if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
				e.preventDefault();
				e.stopPropagation();
				filterText += e.key;
				applyFilter();
				render();
			}
		};
		document.addEventListener('keydown', this.keyHandler, true);

		this.outsideHandler = (evt: MouseEvent) => {
			const target = evt.target as Node;
			if (ac.contains(target)) return;
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
		if (this.keyHandler) {
			document.removeEventListener('keydown', this.keyHandler, true);
			this.keyHandler = null;
		}
	}

	isOpen(): boolean {
		return this.dropdownEl !== null;
	}

	destroy(): void {
		this.close();
	}
}
