import { t, onLocaleChange } from '../i18n/index';

export interface UsageInfo {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens?: number;
  contextWindow?: number;
  contextTokens?: number;
  percentage?: number;
}

export interface ToolbarCallbacks {
  onAgentChange?: (agent: string) => void;
  onModelChange?: (model: string) => void;
  onEffortChange?: (effort: string) => void;
  onPermissionChange?: (mode: string) => void;
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

  constructor(container: HTMLDivElement, private callbacks: ToolbarCallbacks) {
    container.addClass('copsidian-toolbar');
    onLocaleChange(() => this.refreshLocale());

    // ── Single row ──
    const row = container.createDiv({ cls: 'copsidian-toolbar-row' });

    // Custom model selector (hover dropdown)
    this.modelSelectorEl = row.createDiv({ cls: 'copsidian-model-selector' });
    this.modelBtnEl = this.modelSelectorEl.createDiv({ cls: 'copsidian-model-btn' });
    this.modelLabelEl = this.modelBtnEl.createSpan({ cls: 'copsidian-model-label' });
    this.modelLabelEl.setText(t().toolbar.noModels);
    this.modelDropdownEl = this.modelSelectorEl.createDiv({ cls: 'copsidian-model-dropdown' });

    // Mode cycle button (click to cycle)
    this.modeCycleEl = row.createDiv({ cls: 'copsidian-mode-cycle' });
    this.modeCycleLabelEl = this.modeCycleEl.createSpan({ cls: 'copsidian-mode-cycle-label' });
    this.modeCycleLabelEl.setText('—');
    this.modeCycleEl.addEventListener('click', () => this.cycleMode());

    // Custom effort selector (hover dropdown)
    this.effortSelectorEl = row.createDiv({ cls: 'copsidian-effort-selector' });
    this.effortBtnEl = this.effortSelectorEl.createDiv({ cls: 'copsidian-effort-btn' });
    this.effortLabelEl = this.effortBtnEl.createSpan({ cls: 'copsidian-effort-label' });
    this.effortLabelEl.setText('—');
    this.effortDropdownEl = this.effortSelectorEl.createDiv({ cls: 'copsidian-effort-dropdown' });

    // Permission toggle (click to cycle)
    this.permToggleEl = row.createDiv({ cls: 'copsidian-perm-toggle' });
    this.permLabelEl = this.permToggleEl.createSpan({ cls: 'copsidian-perm-label' });
    this.permToggleEl.addEventListener('click', () => this.cyclePermission());
    this.updatePermissionDisplay();

    // Send/Stop button
    this.sendBtn = row.createEl('button', { text: t().toolbar.send, cls: 'copsidian-send-btn' });
    this.sendBtn.onclick = () => this.handleSendClick();
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

  private cycleMode(): void {
    if (this.modeOptions.length <= 1) return;
    const idx = this.modeOptions.findIndex(o => o.value === this.currentMode);
    const next = this.modeOptions[(idx + 1) % this.modeOptions.length];
    this.currentMode = next.value;
    this.modeCycleLabelEl.setText(next.label);
    this.callbacks.onAgentChange?.(next.value);
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
      const emptyEl = this.modelDropdownEl.createDiv({ cls: 'copsidian-model-option empty' });
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
        const separator = this.modelDropdownEl.createDiv({ cls: 'copsidian-model-group' });
        separator.setText(group);
      }
      for (const opt of groupOptions) {
        const optionEl = this.modelDropdownEl.createDiv({ cls: 'copsidian-model-option' });
        if (opt.value === this.currentModel) {
          optionEl.addClass('selected');
        }
        optionEl.setText(opt.label);
        optionEl.addEventListener('click', (e) => {
          e.stopPropagation();
          this.callbacks.onModelChange?.(opt.value);
          this.modelLabelEl.setText(opt.label);
          this.renderModelDropdown();
        });
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
      const emptyEl = this.effortDropdownEl.createDiv({ cls: 'copsidian-effort-option empty' });
      emptyEl.setText('—');
      return;
    }

    for (const opt of options) {
      const optionEl = this.effortDropdownEl.createDiv({ cls: 'copsidian-effort-option' });
      if (opt.value === this.currentEffort) {
        optionEl.addClass('selected');
      }
      optionEl.setText(opt.label);
      optionEl.addEventListener('click', (e) => {
        e.stopPropagation();
        this.callbacks.onEffortChange?.(opt.value);
        this.currentEffort = opt.value;
        this.effortLabelEl.setText(opt.label);
        this.renderEffortDropdown();
      });
    }
  }

  // ── Permission toggle ──

  updatePermission(mode: string): void {
    this.currentPermission = mode;
    this.updatePermissionDisplay();
  }

  private cyclePermission(): void {
    const modes = ['safe', 'plan', 'yolo'];
    const idx = modes.indexOf(this.currentPermission);
    const next = modes[(idx + 1) % modes.length];
    this.currentPermission = next;
    this.updatePermissionDisplay();
    this.callbacks.onPermissionChange?.(next);
  }

  private updatePermissionDisplay(): void {
    const labels: Record<string, string> = {
      safe: '🔒 Safe',
      plan: '📋 Plan',
      yolo: '⚡ Yolo',
    };
    this.permLabelEl.setText(labels[this.currentPermission] ?? '🔒 Safe');
    this.permToggleEl.setAttribute('title', `Permission: ${this.currentPermission} (click to switch)`);
    this.permToggleEl.className = 'copsidian-perm-toggle';
    this.permToggleEl.addClass(`mod-${this.currentPermission}`);
  }

  // ── Sending state ──

  setSending(on: boolean): void {
    this.sending = on;
    this.sendBtn.textContent = on ? t().toolbar.stop : t().toolbar.send;
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
    this.updateEffort([
      { value: 'default', label: t().toolbar.effort.default },
      { value: 'low', label: t().toolbar.effort.low },
      { value: 'medium', label: t().toolbar.effort.medium },
      { value: 'high', label: t().toolbar.effort.high },
    ], this.currentEffort);
    this.setSending(this.sending);
  }
}
