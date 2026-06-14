import { t } from '../i18n/index';
import type { SlashCategory } from '../commands/registry';

export interface ACItem {
  value: string;
  label: string;
  description?: string;
  /** For slash commands: which group section the item belongs to. */
  category?: SlashCategory;
  /** For slash commands: the type badge text (Builtin / ACP / Custom). */
  badge?: string;
}

export interface AutocompleteCallbacks {
  onSelect(value: string, mode: '@' | '/'): void;
}

export class Autocomplete {
  private dropdownEl: HTMLDivElement | null = null;
  private outsideHandler: ((e: MouseEvent) => void) | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private doc: Document;
  /** Current mode (for filtering the right item list). */
  private mode: '@' | '/' = '@';
  /** All available items for the current mode. */
  private allItems: ACItem[] = [];
  /** Filtered (visible) items after applying the query. */
  private filtered: ACItem[] = [];
  /** Current selection index within filtered. */
  private selIdx = 0;
  /** Characters typed after triggering the popover. */
  private filterText = '';

  constructor(
    _container: HTMLElement,
    private callbacks: AutocompleteCallbacks,
  ) {
    this.doc = _container.ownerDocument ?? activeDocument;
  }

  open(items: ACItem[], mode: '@' | '/'): void {
    this.close();
    // Create the dropdown container element
    this.dropdownEl = activeDocument.createElement('div');
    this.dropdownEl.addClass('copsilot-autocomplete');
    document.body.appendChild(this.dropdownEl);
    this.mode = mode;
    this.allItems = items;
    this.filterText = '';
    this.selIdx = 0;
    this.applyFilter();
    this.render();

    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.close();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.key === 'ArrowDown') {
        this.selIdx = Math.min(this.selIdx + 1, Math.max(0, this.filtered.length - 1));
        this.render();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.key === 'ArrowUp') {
        this.selIdx = Math.max(0, this.selIdx - 1);
        this.render();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.key === 'Enter') {
        if (this.filtered.length > 0) {
          this.callbacks.onSelect(this.filtered[this.selIdx].value, mode);
        }
        this.close();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.key === 'Backspace') {
        if (this.filterText.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          this.filterText = this.filterText.slice(0, -1);
          this.applyFilter();
          this.render();
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
        this.filterText += e.key;
        this.applyFilter();
        this.render();
      }
    };
    this.doc.addEventListener('keydown', this.keyHandler, true);

    this.outsideHandler = (evt: MouseEvent) => {
      const target = evt.target as Node;
      if (this.dropdownEl?.contains(target)) return;
      this.close();
    };
    this.doc.addEventListener('mousedown', this.outsideHandler, true);
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
    if (this.keyHandler) {
      this.doc.removeEventListener('keydown', this.keyHandler, true);
      this.keyHandler = null;
    }
    this.allItems = [];
    this.filtered = [];
  }

  isOpen(): boolean {
    return this.dropdownEl !== null;
  }

  destroy(): void {
    this.close();
  }

  // ── Private ──

  private applyFilter(): void {
    if (!this.filterText) {
      this.filtered = [...this.allItems];
    } else {
      const lower = this.filterText.toLowerCase();
      this.filtered = this.allItems.filter(
        (it) =>
          it.label.toLowerCase().includes(lower) ||
          it.description?.toLowerCase().includes(lower),
      );
    }
    this.selIdx = 0;
  }

  /** Render the dropdown with grouped sections for slash commands. */
  private render(): void {
    if (!this.dropdownEl) return;
    const ac = this.dropdownEl;
    ac.empty();

    if (this.filtered.length === 0) {
      ac.createDiv({ cls: 'copsilot-ac-item empty', text: t().autocomplete.noMatches });
      return;
    }

    if (this.mode === '@') {
      // Flat list for @mentions
      for (let i = 0; i < this.filtered.length; i++) {
        this.renderItem(ac, this.filtered[i], i);
      }
      return;
    }

    // Grouped rendering for slash commands (mode === '/')
    const groups = new Map<string, ACItem[]>();
    for (const item of this.filtered) {
      const cat = item.category ?? 'agent';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(item);
    }

    let firstInGroup = true;
    for (const [cat, items] of groups) {
      if (!firstInGroup) {
        ac.createDiv({ cls: 'copsilot-ac-separator' });
      }
      firstInGroup = false;

      // Section header
      const headerLabel = ((t() as unknown) as Record<string, Record<string, string>>).slashCategory?.[cat] ?? cat;
      ac.createDiv({ cls: 'copsilot-ac-header', text: headerLabel });

      for (let i = 0; i < items.length; i++) {
        this.renderItem(ac, items[i], this.filtered.indexOf(items[i]));
      }
    }
  }

  private renderItem(ac: HTMLDivElement, item: ACItem, idx: number): void {
    const el = ac.createDiv({
      cls: `copsilot-ac-item${idx === this.selIdx ? ' selected' : ''}`,
    });

    // Highlight matching portion of the label when filtering @mentions
    if (this.filterText && this.filterText.length > 0 && this.mode === '@') {
      const lower = item.label.toLowerCase();
      const q = this.filterText.toLowerCase();
      const pos = lower.indexOf(q);
      if (pos >= 0) {
        const before = item.label.slice(0, pos);
        const match = item.label.slice(pos, pos + q.length);
        const after = item.label.slice(pos + q.length);
        const labelEl = el.createSpan({ cls: 'ac-label' });
        labelEl.createSpan({ text: before });
        labelEl.createEl('mark', { text: match });
        labelEl.createSpan({ text: after });
      } else {
        el.createSpan({ text: item.label, cls: 'ac-label' });
      }
    } else {
      el.createSpan({ text: item.label, cls: 'ac-label' });
    }

    if (item.badge) {
      el.createSpan({ text: item.badge, cls: 'ac-badge' });
    }

    if (item.description) {
      el.createSpan({ text: item.description, cls: 'ac-desc' });
    }

    el.onclick = () => {
      this.callbacks.onSelect(item.value, this.mode);
      this.close();
    };
  }
}