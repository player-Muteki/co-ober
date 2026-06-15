import { t } from '../i18n/index';

export interface ACItem {
  value: string;
  label: string;
  description?: string;
  /** Group section: SlashCategory for / commands, folder path for @ mentions. */
  category?: string;
  /** Badge text (Builtin / ACP / ✓ for selected). */
  badge?: string;
  /** Argument hint displayed in grey (e.g. "[path/to/dir]"). */
  argumentHint?: string;
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
    private container: HTMLElement,
    private callbacks: AutocompleteCallbacks,
  ) {
    this.doc = container.ownerDocument ?? activeDocument;
  }

  open(items: ACItem[], mode: '@' | '/'): void {
    this.close();
    // Create the dropdown container element
    this.dropdownEl = this.doc.createElement('div');
    this.dropdownEl.addClass('copsilot-ac-dropdown');
    this.container.appendChild(this.dropdownEl);
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
      // Flat list — only @name label, no description, just optional ✓ badge
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

    // First row: label + badge
    const row1 = el.createDiv({ cls: 'ac-row' });

    // Highlight matching portion of the label when filtering @mentions
    if (this.filterText && this.filterText.length > 0 && this.mode === '@') {
      const lower = item.label.toLowerCase();
      const q = this.filterText.toLowerCase();
      const pos = lower.indexOf(q);
      if (pos >= 0) {
        const before = item.label.slice(0, pos);
        const match = item.label.slice(pos, pos + q.length);
        const after = item.label.slice(pos + q.length);
        const labelEl = row1.createSpan({ cls: 'ac-label' });
        labelEl.createSpan({ text: before });
        labelEl.createEl('mark', { text: match });
        labelEl.createSpan({ text: after });
      } else {
        row1.createSpan({ text: item.label, cls: 'ac-label' });
      }
    } else {
      row1.createSpan({ text: item.label, cls: 'ac-label' });
    }

    if (item.badge) {
      row1.createSpan({ text: item.badge, cls: `ac-badge ac-badge-${item.badge.toLowerCase()}` });
    }

    // Second row: argument hint + description
    if (item.argumentHint || item.description) {
      const row2 = el.createDiv({ cls: 'ac-row ac-row-sub' });
      if (item.argumentHint) {
        row2.createSpan({ text: item.argumentHint, cls: 'ac-arg-hint' });
      }
      if (item.description) {
        row2.createSpan({ text: item.description, cls: 'ac-desc' });
      }
    }

    el.onclick = () => {
      this.callbacks.onSelect(item.value, this.mode);
      this.close();
    };
  }
}