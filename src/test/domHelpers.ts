type CreateElOptions = {
  cls?: string;
  text?: string;
  attr?: Record<string, string>;
};

export function installObsidianDomHelpers(): void {
  HTMLElement.prototype.addClass = function addClass(cls: string): void {
    this.classList.add(...cls.split(' ').filter(Boolean));
  };

  HTMLElement.prototype.removeClass = function removeClass(cls: string): void {
    this.classList.remove(...cls.split(' ').filter(Boolean));
  };

  HTMLElement.prototype.createEl = function createEl<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    options: CreateElOptions = {},
  ): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    applyOptions(el, options);
    this.appendChild(el);
    return el;
  };

  HTMLElement.prototype.createDiv = function createDiv(options: CreateElOptions = {}): HTMLDivElement {
    return this.createEl('div', options);
  };

  HTMLElement.prototype.createSpan = function createSpan(options: CreateElOptions = {}): HTMLSpanElement {
    return this.createEl('span', options);
  };

  HTMLElement.prototype.empty = function empty(): void {
    this.replaceChildren();
  };

  HTMLElement.prototype.setText = function setText(text: string): void {
    this.textContent = text;
  };
}

function applyOptions(el: HTMLElement, options: CreateElOptions): void {
  if (options.cls) el.addClass(options.cls);
  if (options.text !== undefined) el.textContent = options.text;
  if (options.attr) {
    for (const [key, value] of Object.entries(options.attr)) {
      el.setAttribute(key, value);
    }
  }
}
