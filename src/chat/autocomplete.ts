interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

export class Autocomplete {
  private container: HTMLDivElement;
  private selectedIdx = 0;
  private items: AutocompleteItem[] = [];
  private visible = false;

  constructor(
    container: HTMLDivElement,
    _mode: '@' | '/',
    items: AutocompleteItem[],
    private onSelect: (value: string) => void,
  ) {
    this.container = container;
    this.items = items;
    this.render();
  }

  show(): void {
    if (!this.visible) {
      this.visible = true;
      this.container.style.display = '';
    }
    this.selectedIdx = 0;
    this.render();
  }

  hide(): void {
    this.visible = false;
    this.container.style.display = 'none';
  }

  destroy(): void {
    this.hide();
    this.container.remove();
  }

  moveUp(): void {
    this.selectedIdx = this.selectedIdx > 0 ? this.selectedIdx - 1 : this.items.length > 0 ? this.items.length - 1 : 0;
    this.render();
  }

  moveDown(): void {
    this.selectedIdx = this.selectedIdx < this.items.length - 1 ? this.selectedIdx + 1 : 0;
    this.render();
  }

  selectCurrent(): void {
    if (this.items[this.selectedIdx]) {
      this.onSelect(this.items[this.selectedIdx].value);
      this.hide();
    }
  }

  private render(): void {
    this.container.empty();
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      const el = this.container.createDiv({ cls: `copsidian-ac-item${i === this.selectedIdx ? ' selected' : ''}` });
      el.createSpan({ text: item.label, cls: 'ac-label' });
      if (item.description) el.createSpan({ text: item.description, cls: 'ac-desc' });
      el.onclick = () => { this.onSelect(item.value); this.hide(); };
    }
  }
}
