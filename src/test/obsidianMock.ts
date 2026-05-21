export const MarkdownRenderer = {
  renderMarkdown: async (_markdown: string, el: HTMLElement): Promise<void> => {
    el.textContent = _markdown;
  },
};

export class Component {}

export class ItemView extends Component {
  contentEl: HTMLDivElement;

  constructor(public leaf: unknown) {
    super();
    this.contentEl = document.createElement('div');
  }

  getViewType(): string { return ''; }
  getDisplayText(): string { return ''; }
  getIcon(): string { return ''; }
  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}
}

export class PluginSettingTab {
  containerEl: HTMLDivElement;
  app: unknown;
  plugin: unknown;

  constructor(app: unknown, plugin: unknown) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = document.createElement('div');
  }

  display(): void {}
}

export class Notice {
  constructor(public message: string) {}
}

export class Setting {
  settingEl: HTMLDivElement;
  nameEl: HTMLDivElement;
  descEl: HTMLDivElement;
  controlEl: HTMLDivElement;

  constructor(containerEl: HTMLElement) {
    this.settingEl = containerEl.createDiv({ cls: 'setting-item' });
    this.nameEl = this.settingEl.createDiv({ cls: 'setting-item-name' });
    this.descEl = this.settingEl.createDiv({ cls: 'setting-item-description' });
    this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' });
  }

  setName(name: string): this {
    this.nameEl.textContent = name;
    return this;
  }

  setDesc(desc: string): this {
    this.descEl.textContent = desc;
    return this;
  }

  setHeading(): this {
    this.settingEl.addClass('setting-item-heading');
    return this;
  }

  addText(callback: (component: TextComponent) => void): this {
    callback(new TextComponent(this.controlEl));
    return this;
  }

  addTextArea(callback: (component: TextAreaComponent) => void): this {
    callback(new TextAreaComponent(this.controlEl));
    return this;
  }

  addDropdown(callback: (component: DropdownComponent) => void): this {
    callback(new DropdownComponent(this.controlEl));
    return this;
  }

  addToggle(callback: (component: ToggleComponent) => void): this {
    callback(new ToggleComponent(this.controlEl));
    return this;
  }

  addButton(callback: (component: ButtonComponent) => void): this {
    callback(new ButtonComponent(this.controlEl));
    return this;
  }
}

class TextComponent {
  inputEl: HTMLInputElement;
  private changeHandler: ((value: string) => void | Promise<void>) | null = null;

  constructor(containerEl: HTMLElement) {
    this.inputEl = containerEl.createEl('input');
    this.inputEl.onchange = () => { void this.changeHandler?.(this.inputEl.value); };
  }

  setValue(value: string): this { this.inputEl.value = value; return this; }
  setPlaceholder(value: string): this { this.inputEl.placeholder = value; return this; }
  onChange(handler: (value: string) => void | Promise<void>): this { this.changeHandler = handler; return this; }
}

class TextAreaComponent {
  inputEl: HTMLTextAreaElement;
  private changeHandler: ((value: string) => void | Promise<void>) | null = null;

  constructor(containerEl: HTMLElement) {
    this.inputEl = containerEl.createEl('textarea');
    this.inputEl.onchange = () => { void this.changeHandler?.(this.inputEl.value); };
  }

  setValue(value: string): this { this.inputEl.value = value; return this; }
  setPlaceholder(value: string): this { this.inputEl.placeholder = value; return this; }
  onChange(handler: (value: string) => void | Promise<void>): this { this.changeHandler = handler; return this; }
}

class DropdownComponent {
  selectEl: HTMLSelectElement;
  private changeHandler: ((value: string) => void | Promise<void>) | null = null;

  constructor(containerEl: HTMLElement) {
    this.selectEl = containerEl.createEl('select');
    this.selectEl.onchange = () => { void this.changeHandler?.(this.selectEl.value); };
  }

  addOptions(options: Record<string, string>): this {
    for (const [value, label] of Object.entries(options)) {
      this.selectEl.createEl('option', { text: label, attr: { value } });
    }
    return this;
  }

  setValue(value: string): this { this.selectEl.value = value; return this; }
  onChange(handler: (value: string) => void | Promise<void>): this { this.changeHandler = handler; return this; }
}

class ToggleComponent {
  toggleEl: HTMLInputElement;
  private changeHandler: ((value: boolean) => void | Promise<void>) | null = null;

  constructor(containerEl: HTMLElement) {
    this.toggleEl = containerEl.createEl('input');
    this.toggleEl.type = 'checkbox';
    this.toggleEl.onchange = () => { void this.changeHandler?.(this.toggleEl.checked); };
  }

  setValue(value: boolean): this { this.toggleEl.checked = value; return this; }
  onChange(handler: (value: boolean) => void | Promise<void>): this { this.changeHandler = handler; return this; }
}

class ButtonComponent {
  buttonEl: HTMLButtonElement;

  constructor(containerEl: HTMLElement) {
    this.buttonEl = containerEl.createEl('button');
  }

  setButtonText(text: string): this { this.buttonEl.textContent = text; return this; }
  setCta(): this { this.buttonEl.addClass('mod-cta'); return this; }
  onClick(handler: () => void | Promise<void>): this { this.buttonEl.onclick = () => { void handler(); }; return this; }
}
