type CreateElOptions = {
  cls?: string;
  text?: string;
  attr?: Record<string, string>;
};

type CreateSvgOptions = {
  cls?: string;
  attr?: Record<string, string | number | boolean | null>;
};

type GlobalDomHelpers = {
  createEl: <K extends keyof HTMLElementTagNameMap>(tag: K, options?: CreateElOptions | string) => HTMLElementTagNameMap[K];
  createDiv: (options?: CreateElOptions | string) => HTMLDivElement;
  createSpan: (options?: CreateElOptions | string) => HTMLSpanElement;
  createSvg: <K extends keyof SVGElementTagNameMap>(tag: K, options?: CreateSvgOptions | string) => SVGElementTagNameMap[K];
};

export function installObsidianDomHelpers(): void {
  const g = globalThis as unknown as GlobalDomHelpers;
  g.createEl = function createEl<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    options: CreateElOptions | string = {},
  ): HTMLElementTagNameMap[K] {
    const normalized: CreateElOptions = typeof options === 'string' ? { cls: options } : options;
    const el = document.createElement(tag);
    applyOptions(el, normalized);
    return el;
  };
  g.createDiv = function createDiv(options: CreateElOptions | string = {}): HTMLDivElement {
    return g.createEl('div', options);
  };
  g.createSpan = function createSpan(options: CreateElOptions | string = {}): HTMLSpanElement {
    return g.createEl('span', options);
  };
  g.createSvg = function createSvg<K extends keyof SVGElementTagNameMap>(
    tag: K,
    options: CreateSvgOptions | string = {},
  ): SVGElementTagNameMap[K] {
    const normalized: CreateSvgOptions = typeof options === 'string' ? { cls: options } : options;
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag) as SVGElementTagNameMap[K];
    if (normalized.cls) el.classList.add(...normalized.cls.split(' ').filter(Boolean));
    if (normalized.attr) {
      for (const [key, value] of Object.entries(normalized.attr)) {
        if (value !== null && value !== undefined) el.setAttribute(key, String(value));
      }
    }
    return el;
  };

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

  // SVG variant — Obsidian augments every Element with createSvg so both
  // HTMLElement parents (the meter's div) and SVGElement parents (the <svg>
  // element and its <defs>/<clipPath>) can host a chain of child creates.
  (Element.prototype as unknown as { createSvg: <K extends keyof SVGElementTagNameMap>(tag: K, options?: CreateSvgOptions) => SVGElementTagNameMap[K] }).createSvg =
    function createSvg<K extends keyof SVGElementTagNameMap>(
      this: Element,
      tag: K,
      options: CreateSvgOptions = {},
    ): SVGElementTagNameMap[K] {
      const el = document.createElementNS('http://www.w3.org/2000/svg', tag) as SVGElementTagNameMap[K];
      if (options.cls) el.classList.add(...options.cls.split(' ').filter(Boolean));
      if (options.attr) {
        for (const [key, value] of Object.entries(options.attr)) {
          if (value !== null && value !== undefined) el.setAttribute(key, String(value));
        }
      }
      this.appendChild(el);
      return el;
    };

  HTMLElement.prototype.empty = function empty(): void {
    this.replaceChildren();
  };

  HTMLElement.prototype.setText = function setText(text: string): void {
    this.textContent = text;
  };

  HTMLElement.prototype.setCssProps = function setCssProps(props: Record<string, string>): void {
    for (const [key, value] of Object.entries(props)) {
      this.style.setProperty(key, value);
    }
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
