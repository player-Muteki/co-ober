import { setIcon } from 'obsidian';
import { t, onLocaleChange } from '../i18n/index';

export interface ToolbarCallbacks {
  onAgentChange?: (agent: string) => void;
  onModelChange?: (model: string) => void;
  onEffortChange?: (effort: string) => void;
  onPermissionChange?: (mode: string) => void;
  onAttachImage?: () => void;
  onSend?: () => void;
  onStop?: () => void;
}

export class InputToolbar {
  private sendBtn: HTMLButtonElement;
  private sending = false;

  // Custom model selector
  private modelSelectorEl: HTMLDivElement;
  private modelBtnEl: HTMLDivElement;
  private modelLabelEl: HTMLSpanElement;
  private modelDropdownEl: HTMLDivElement;
  private modelOptions: Array<{ value: string; label: string }> = [];
  private currentModel: string | undefined;

  // Mode cycle button
  private modeCycleEl: HTMLDivElement;
  private modeCycleLabelEl: HTMLSpanElement;
  private modeOptions: Array<{ value: string; label: string }> = [];
  private currentMode: string | undefined;

  // Custom effort selector
  private effortSelectorEl: HTMLDivElement;
  private effortBtnEl: HTMLDivElement;
  private effortLabelEl: HTMLSpanElement;
  private effortDropdownEl: HTMLDivElement;
  private effortOptions: Array<{ value: string; label: string }> = [];
  private currentEffort: string | undefined;

  // Permission toggle
  private permToggleEl: HTMLDivElement;
  private permLabelEl: HTMLSpanElement;
  private currentPermission: string = 'safe';

  // Image attach button
  private attachBtnEl: HTMLButtonElement;

  private readonly unsubscribeLocale: () => void;
  // Close fns registered by wireDropdown, keyed by the selector container.
  private readonly dropdownClosers = new Map<HTMLElement, () => void>();
  private readonly domDisposers: Array<() => void> = [];

  constructor(container: HTMLDivElement, private callbacks: ToolbarCallbacks) {
    container.addClass('co-ober-toolbar');
    this.unsubscribeLocale = onLocaleChange(() => this.refreshLocale());

    // ── Single row ──
    const row = container.createDiv({ cls: 'co-ober-toolbar-row' });

    // Custom model selector (hover + keyboard dropdown)
    this.modelSelectorEl = row.createDiv({ cls: 'co-ober-model-selector' });
    this.modelBtnEl = this.modelSelectorEl.createDiv({ cls: 'co-ober-model-btn' });
    this.modelBtnEl.setAttribute('role', 'button');
    this.modelBtnEl.setAttribute('tabindex', '0');
    this.modelBtnEl.setAttribute('aria-haspopup', 'listbox');
    this.modelBtnEl.setAttribute('aria-expanded', 'false');
    this.modelLabelEl = this.modelBtnEl.createSpan({ cls: 'co-ober-model-label' });
    this.modelLabelEl.setText(t().toolbar.noModels);
    this.modelDropdownEl = this.modelSelectorEl.createDiv({ cls: 'co-ober-model-dropdown' });
    this.modelDropdownEl.setAttribute('role', 'listbox');
    this.wireDropdown(this.modelSelectorEl, this.modelBtnEl, this.modelDropdownEl, '.co-ober-model-option:not(.empty)');

    // Mode cycle button (click to cycle)
    this.modeCycleEl = row.createDiv({ cls: 'co-ober-mode-cycle' });
    this.modeCycleLabelEl = this.modeCycleEl.createSpan({ cls: 'co-ober-mode-cycle-label' });
    this.modeCycleLabelEl.setText('—');
    this.modeCycleEl.addEventListener('click', () => this.cycleMode());

    // Custom effort selector (hover + keyboard dropdown)
    this.effortSelectorEl = row.createDiv({ cls: 'co-ober-effort-selector' });
    this.effortBtnEl = this.effortSelectorEl.createDiv({ cls: 'co-ober-effort-btn' });
    this.effortBtnEl.setAttribute('role', 'button');
    this.effortBtnEl.setAttribute('tabindex', '0');
    this.effortBtnEl.setAttribute('aria-haspopup', 'listbox');
    this.effortBtnEl.setAttribute('aria-expanded', 'false');
    this.effortLabelEl = this.effortBtnEl.createSpan({ cls: 'co-ober-effort-label' });
    this.effortLabelEl.setText('—');
    this.effortDropdownEl = this.effortSelectorEl.createDiv({ cls: 'co-ober-effort-dropdown' });
    this.effortDropdownEl.setAttribute('role', 'listbox');
    this.wireDropdown(this.effortSelectorEl, this.effortBtnEl, this.effortDropdownEl, '.co-ober-effort-option:not(.empty)');

    // Permission toggle (click to cycle)
    this.permToggleEl = row.createDiv({ cls: 'co-ober-perm-toggle' });
    this.permLabelEl = this.permToggleEl.createSpan({ cls: 'co-ober-perm-label' });
    this.permToggleEl.addEventListener('click', () => this.cyclePermission());
    this.updatePermissionDisplay();

    // Image attach button
    this.attachBtnEl = row.createEl('button', { cls: 'co-ober-attach-btn' });
    setIcon(this.attachBtnEl, 'paperclip');
    this.attachBtnEl.title = t().toolbar.attachImage;
    this.attachBtnEl.onclick = () => {
      // Disabled state only comes from agent capabilities, but a synthetic
      // click can bypass it; the send path strips images regardless.
      if (this.attachBtnEl.disabled) return;
      this.callbacks.onAttachImage?.();
    };

    // Send/Stop button
    this.sendBtn = row.createEl('button', { cls: 'co-ober-send-btn' });
    setIcon(this.sendBtn, 'send');
    this.sendBtn.onclick = () => this.handleSendClick();
  }

  dispose(): void {
    this.unsubscribeLocale();
    for (const disposeDom of this.domDisposers) disposeDom();
    this.domDisposers.length = 0;
    this.dropdownClosers.clear();
  }

  private handleSendClick(): void {
    if (this.sendBtn.classList.contains('mod-stop')) {
      this.callbacks.onStop?.();
    } else {
      this.callbacks.onSend?.();
    }
  }

  // ── Mode cycle button ──

  updateAgents(options: Array<{ value: string; label: string }>, current?: string): void {
    this.modeOptions = [...options];
    this.currentMode = current;
    const selected = options.find(o => o.value === current);
    this.modeCycleLabelEl.setText(selected?.label ?? options[0]?.label ?? '—');
    this.modeCycleEl.classList.toggle('has-options', options.length > 1);
  }

  cycleMode(): void {
    if (this.modeOptions.length <= 1) return;
    const idx = this.modeOptions.findIndex(o => o.value === this.currentMode);
    const next = this.modeOptions[(idx + 1) % this.modeOptions.length];
    this.currentMode = next.value;
    this.modeCycleLabelEl.setText(next.label);
    this.callbacks.onAgentChange?.(next.value);
  }

  cycleModeReverse(): void {
    if (this.modeOptions.length <= 1) return;
    const idx = this.modeOptions.findIndex(o => o.value === this.currentMode);
    const prev = this.modeOptions[(idx - 1 + this.modeOptions.length) % this.modeOptions.length];
    this.currentMode = prev.value;
    this.modeCycleLabelEl.setText(prev.label);
    this.callbacks.onAgentChange?.(prev.value);
  }

  // ── Model custom dropdown ──

  updateModels(options: Array<{ value: string; label: string }>, current?: string): void {
    this.modelOptions = [...options];
    this.currentModel = current;
    this.renderModelDropdown();

    if (options.length === 0) {
      this.modelLabelEl.setText(t().toolbar.noModels);
    } else {
      const selected = options.find(o => o.value === current);
      this.modelLabelEl.setText(selected?.label ?? options[0].label);
    }
  }

  private renderModelDropdown(): void {
    this.modelDropdownEl.empty();
    const options = this.modelOptions;

    if (options.length === 0) {
      const emptyEl = this.modelDropdownEl.createDiv({ cls: 'co-ober-model-option empty' });
      emptyEl.setText(t().toolbar.noModels);
      return;
    }

    // Group by provider
    const groups = new Map<string, Array<{ value: string; label: string }>>();
    for (const opt of options) {
      const parts = opt.value.split('/');
      const group = parts.length > 1 ? parts[0] : '';
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push(opt);
    }

    for (const [group, groupOptions] of groups) {
      if (group && groups.size > 1) {
        const separator = this.modelDropdownEl.createDiv({ cls: 'co-ober-model-group' });
        separator.setText(group);
      }
      for (const opt of groupOptions) {
        const optionEl = this.modelDropdownEl.createDiv({ cls: 'co-ober-model-option' });
        const isSelected = opt.value === this.currentModel;
        if (isSelected) {
          optionEl.addClass('selected');
        }
        optionEl.setAttribute('role', 'option');
        optionEl.setAttribute('tabindex', '-1');
        optionEl.setAttribute('aria-selected', String(isSelected));
        optionEl.setText(opt.label);
        const activate = (): void => {
          this.currentModel = opt.value;
          this.callbacks.onModelChange?.(opt.value);
          this.modelLabelEl.setText(opt.label);
          this.dropdownClosers.get(this.modelSelectorEl)?.();
          this.renderModelDropdown();
          this.modelBtnEl.focus();
        };
        optionEl.addEventListener('click', (e) => {
          e.stopPropagation();
          activate();
        });
        this.wireOptionKeys(optionEl, activate);
      }
    }
  }

  // ── Effort custom dropdown ──

  updateEffort(options: Array<{ value: string; label: string }>, current?: string): void {
    this.effortOptions = [...options];
    this.currentEffort = current;
    this.renderEffortDropdown();

    if (current) {
      const selected = options.find(o => o.value === current);
      this.effortLabelEl.setText(selected?.label ?? options[0]?.label ?? '—');
    } else if (options.length > 0) {
      this.effortLabelEl.setText(options[0].label);
    }
  }

  private renderEffortDropdown(): void {
    this.effortDropdownEl.empty();
    const options = this.effortOptions;

    if (options.length === 0) {
      const emptyEl = this.effortDropdownEl.createDiv({ cls: 'co-ober-effort-option empty' });
      emptyEl.setText('—');
      return;
    }

    for (const opt of options) {
      const optionEl = this.effortDropdownEl.createDiv({ cls: 'co-ober-effort-option' });
      const isSelected = opt.value === this.currentEffort;
      if (isSelected) {
        optionEl.addClass('selected');
      }
      optionEl.setAttribute('role', 'option');
      optionEl.setAttribute('tabindex', '-1');
      optionEl.setAttribute('aria-selected', String(isSelected));
      optionEl.setText(opt.label);
      const activate = (): void => {
        this.currentEffort = opt.value;
        this.callbacks.onEffortChange?.(opt.value);
        this.effortLabelEl.setText(opt.label);
        this.dropdownClosers.get(this.effortSelectorEl)?.();
        this.renderEffortDropdown();
        this.effortBtnEl.focus();
      };
      optionEl.addEventListener('click', (e) => {
        e.stopPropagation();
        activate();
      });
      this.wireOptionKeys(optionEl, activate);
    }
  }

  // ── Permission toggle ──

  updatePermission(mode: string): void {
    this.currentPermission = mode;
    this.updatePermissionDisplay();
  }

  private cyclePermission(): void {
    const modes = ['safe', 'readonly', 'plan', 'yolo'];
    const idx = modes.indexOf(this.currentPermission);
    const next = modes[(idx + 1) % modes.length];
    this.currentPermission = next;
    this.updatePermissionDisplay();
    this.callbacks.onPermissionChange?.(next);
  }

  private updatePermissionDisplay(): void {
    const labels: Record<string, string> = {
      safe: t().toolbar.permSafe,
      readonly: t().toolbar.permReadonly,
      plan: t().toolbar.permPlan,
      yolo: t().toolbar.permYolo,
    };
    this.permLabelEl.setText(labels[this.currentPermission] ?? t().toolbar.permSafe);
    this.permToggleEl.setAttribute(
      'title',
      t().toolbar.permTitle.replace('{mode}', this.currentPermission),
    );
    this.permToggleEl.className = 'co-ober-perm-toggle';
    this.permToggleEl.addClass(`mod-${this.currentPermission}`);
  }

  // ── Keyboard-accessible dropdown helpers ──

  private wireDropdown(
    selectorEl: HTMLElement,
    btnEl: HTMLElement,
    dropdownEl: HTMLElement,
    optionSelector: string,
  ): void {
    const isOpen = (): boolean => selectorEl.classList.contains('open');
    const open = (): void => {
      selectorEl.classList.add('open');
      btnEl.setAttribute('aria-expanded', 'true');
      const first = dropdownEl.querySelector<HTMLElement>(optionSelector);
      first?.focus();
    };
    const close = (): void => {
      selectorEl.classList.remove('open');
      btnEl.setAttribute('aria-expanded', 'false');
    };
    this.dropdownClosers.set(selectorEl, close);
    btnEl.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (isOpen()) close();
      else open();
    });
    btnEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        open();
      }
    });
    // Escape anywhere in the selector closes it and returns focus to the button.
    selectorEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        btnEl.focus();
      }
    });
    // Arrow navigation between options.
    dropdownEl.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = Array.from(dropdownEl.querySelectorAll<HTMLElement>(optionSelector));
      if (items.length === 0) return;
      e.preventDefault();
      const idx = items.indexOf(document.activeElement as HTMLElement);
      const next = e.key === 'ArrowDown'
        ? items[(idx + 1) % items.length]
        : items[(idx - 1 + items.length) % items.length];
      next.focus();
    });
    // Clicking or focusing outside closes the dropdown.
    const outside = (ev: Event): void => {
      if (!selectorEl.contains(ev.target as Node)) close();
    };
    document.addEventListener('click', outside);
    this.domDisposers.push(() => document.removeEventListener('click', outside));
    selectorEl.addEventListener('focusout', (ev) => {
      const next = ev.relatedTarget as Node | null;
      if (next && !selectorEl.contains(next)) close();
    });
  }

  private wireOptionKeys(optionEl: HTMLElement, activate: () => void): void {
    optionEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    });
  }

  setImageAttachEnabled(enabled: boolean): void {
    this.attachBtnEl.disabled = !enabled;
    this.attachBtnEl.classList.toggle('is-disabled', !enabled);
    this.attachBtnEl.title = enabled ? t().toolbar.attachImage : t().toolbar.attachImageUnsupported;
  }

  // ── Sending state ──

  setSending(on: boolean): void {
    this.sending = on;
    this.sendBtn.empty();
    setIcon(this.sendBtn, on ? 'square' : 'send');
    this.sendBtn.classList.toggle('mod-stop', on);
    this.sendBtn.disabled = false;
  }

  // ── Locale refresh ──

  refreshLocale(): void {
    this.modelLabelEl.setText(
      this.currentModel
        ? (this.modelOptions.find(o => o.value === this.currentModel)?.label ?? t().toolbar.noModels)
        : t().toolbar.noModels
    );
    this.renderModelDropdown();
    const selected = this.modeOptions.find(o => o.value === this.currentMode);
    this.modeCycleLabelEl.setText(selected?.label ?? this.modeOptions[0]?.label ?? '—');
    this.updatePermissionDisplay();
    this.attachBtnEl.title = this.attachBtnEl.disabled
      ? t().toolbar.attachImageUnsupported
      : t().toolbar.attachImage;
    this.updateEffort([
      { value: 'default', label: t().toolbar.effort.default },
      { value: 'low', label: t().toolbar.effort.low },
      { value: 'medium', label: t().toolbar.effort.medium },
      { value: 'high', label: t().toolbar.effort.high },
    ], this.currentEffort);
    this.setSending(this.sending);
  }
}
