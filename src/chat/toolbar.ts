import { t, onLocaleChange } from '../i18n/index';

export interface ToolbarCallbacks {
  onAgentChange?: (agent: string) => void;
  onModelChange?: (model: string) => void;
  onEffortChange?: (effort: string) => void;
  onPermissionChange?: (mode: string) => void;
  onSend?: () => void;
  onStop?: () => void;
}

export class InputToolbar {
  private effortSelect: HTMLSelectElement;
  private sendBtn: HTMLButtonElement;
  private sendingEl: HTMLSpanElement;
  private sending = false;

  // Custom model selector
  private modelSelectorEl: HTMLDivElement;
  private modelBtnEl: HTMLDivElement;
  private modelLabelEl: HTMLSpanElement;
  private modelDropdownEl: HTMLDivElement;
  private modelOptions: Array<{ value: string; label: string }> = [];
  private currentModel: string | undefined;

  // Mode segmented buttons
  private modeGroupEl: HTMLDivElement;
  private modeOptions: Array<{ value: string; label: string }> = [];
  private currentMode: string | undefined;

  // Permission toggle
  private permToggleEl: HTMLDivElement;
  private permLabelEl: HTMLSpanElement;
  private permSwitchEl: HTMLDivElement;
  private currentPermission: string = 'safe';

  constructor(container: HTMLDivElement, private callbacks: ToolbarCallbacks) {
    container.addClass('copsidian-toolbar');
    onLocaleChange(() => this.refreshLocale());

    // Custom model selector (hover dropdown)
    this.modelSelectorEl = container.createDiv({ cls: 'copsidian-model-selector' });
    this.modelBtnEl = this.modelSelectorEl.createDiv({ cls: 'copsidian-model-btn' });
    this.modelLabelEl = this.modelBtnEl.createSpan({ cls: 'copsidian-model-label' });
    this.modelLabelEl.setText(t().toolbar.noModels);
    this.modelDropdownEl = this.modelSelectorEl.createDiv({ cls: 'copsidian-model-dropdown' });

    // Mode segmented buttons
    this.modeGroupEl = container.createDiv({ cls: 'copsidian-mode-group' });

    // Effort dropdown
    this.effortSelect = container.createEl('select', { cls: 'copsidian-dropdown tb-select tb-effort' });
    this.effortSelect.title = t().toolbar.effortTitle;
    this.effortSelect.onchange = () => this.callbacks.onEffortChange?.(this.effortSelect.value);

    // Permission toggle
    this.permToggleEl = container.createDiv({ cls: 'copsidian-perm-toggle' });
    this.permLabelEl = this.permToggleEl.createSpan({ cls: 'copsidian-perm-label' });
    this.permSwitchEl = this.permToggleEl.createDiv({ cls: 'copsidian-perm-switch' });
    this.permToggleEl.addEventListener('click', () => this.cyclePermission());

    // Sending indicator
    this.sendingEl = container.createSpan({ cls: 'copsidian-toolbar-sending' });
    this.sendingEl.style.display = 'none';

    // Send/Stop button
    this.sendBtn = container.createEl('button', { text: t().toolbar.send, cls: 'copsidian-send-btn' });
    this.sendBtn.onclick = () => this.handleSendClick();

    this.updatePermissionDisplay();
  }

  private handleSendClick(): void {
    if (this.sendBtn.classList.contains('mod-stop')) {
      this.callbacks.onStop?.();
    } else {
      this.callbacks.onSend?.();
    }
  }

  // ── Mode (Agent) segmented buttons ──

  updateAgents(options: Array<{ value: string; label: string }>, current?: string): void {
    this.modeOptions = [...options];
    this.currentMode = current;
    this.renderModeButtons();
  }

  private renderModeButtons(): void {
    this.modeGroupEl.empty();
    if (this.modeOptions.length === 0) return;

    for (const opt of this.modeOptions) {
      const btn = this.modeGroupEl.createDiv({ cls: 'copsidian-mode-btn' });
      btn.setText(opt.label);
      if (opt.value === this.currentMode) {
        btn.addClass('active');
      }
      btn.addEventListener('click', () => {
        this.callbacks.onAgentChange?.(opt.value);
        this.currentMode = opt.value;
        this.renderModeButtons();
      });
    }
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

  // ── Effort ──

  updateEffort(options: Array<{ value: string; label: string }>, current?: string): void {
    this.effortSelect.empty();
    for (const o of options) this.effortSelect.createEl('option', { text: o.label, value: o.value });
    if (current) this.effortSelect.value = current;
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

    // Visual state
    this.permSwitchEl.className = 'copsidian-perm-switch';
    this.permSwitchEl.addClass(`mod-${this.currentPermission}`);
  }

  // ── Sending state ──

  setSending(on: boolean): void {
    this.sending = on;
    this.sendingEl.style.display = on ? '' : 'none';
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
    this.effortSelect.title = t().toolbar.effortTitle;
    this.renderModelDropdown();
    this.renderModeButtons();
    this.updatePermissionDisplay();
    this.updateEffort([
      { value: 'default', label: t().toolbar.effort.default },
      { value: 'low', label: t().toolbar.effort.low },
      { value: 'medium', label: t().toolbar.effort.medium },
      { value: 'high', label: t().toolbar.effort.high },
    ], this.effortSelect.value);
    this.setSending(this.sending);
  }
}
