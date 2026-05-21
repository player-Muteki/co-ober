import { t } from '../i18n/index';

export interface ToolbarCallbacks {
  onAgentChange?: (agent: string) => void;
  onModelChange?: (model: string) => void;
  onEffortChange?: (effort: string) => void;
  onSend?: () => void;
  onStop?: () => void;
}

export class InputToolbar {
  private agentSelect: HTMLSelectElement;
  private modelSelect: HTMLSelectElement;
  private effortSelect: HTMLSelectElement;
  private sendBtn: HTMLButtonElement;
  private sendingEl: HTMLSpanElement;
  private sending = false;
  private modelOptions: Array<{ value: string; label: string }> = [];
  private currentModel: string | undefined;

  constructor(container: HTMLDivElement, private callbacks: ToolbarCallbacks) {
    container.addClass('copsidian-toolbar');

    this.modelSelect = container.createEl('select', { cls: 'copsidian-dropdown tb-select tb-model' });
    this.modelSelect.title = t().toolbar.modelTitle;
    this.modelSelect.onchange = () => this.callbacks.onModelChange?.(this.modelSelect.value);

    this.agentSelect = container.createEl('select', { cls: 'copsidian-dropdown tb-select tb-agent' });
    this.agentSelect.title = t().toolbar.agentTitle;
    this.agentSelect.onchange = () => this.callbacks.onAgentChange?.(this.agentSelect.value);

    this.effortSelect = container.createEl('select', { cls: 'copsidian-dropdown tb-select tb-effort' });
    this.effortSelect.title = t().toolbar.effortTitle;
    this.effortSelect.onchange = () => this.callbacks.onEffortChange?.(this.effortSelect.value);

    this.sendingEl = container.createSpan({ cls: 'copsidian-toolbar-sending' });
    this.sendingEl.style.display = 'none';

    this.sendBtn = container.createEl('button', { text: t().toolbar.send, cls: 'copsidian-send-btn' });
    this.sendBtn.onclick = () => this.handleSendClick();
  }

  private handleSendClick(): void {
    if (this.sendBtn.classList.contains('mod-stop')) {
      this.callbacks.onStop?.();
    } else {
      this.callbacks.onSend?.();
    }
  }

  updateAgents(options: Array<{ value: string; label: string }>, current?: string): void {
    this.agentSelect.empty();
    if (options.length === 0) {
      this.agentSelect.createEl('option', { text: '—', value: '' });
    } else {
      for (const o of options) this.agentSelect.createEl('option', { text: o.label, value: o.value });
      if (current) this.agentSelect.value = current;
    }
  }

  updateModels(options: Array<{ value: string; label: string }>, current?: string): void {
    this.modelOptions = [...options];
    this.currentModel = current;
    this.modelSelect.empty();
    if (options.length === 0) {
      this.modelSelect.createEl('option', { text: t().toolbar.noModels, value: '' });
    } else {
      for (const o of options) this.modelSelect.createEl('option', { text: o.label, value: o.value });
      if (current) this.modelSelect.value = current;
    }
  }

  updateEffort(options: Array<{ value: string; label: string }>, current?: string): void {
    this.effortSelect.empty();
    for (const o of options) this.effortSelect.createEl('option', { text: o.label, value: o.value });
    if (current) this.effortSelect.value = current;
  }

  setSending(on: boolean): void {
    this.sending = on;
    this.sendingEl.style.display = on ? '' : 'none';
    this.sendBtn.textContent = on ? t().toolbar.stop : t().toolbar.send;
    this.sendBtn.classList.toggle('mod-stop', on);
    this.sendBtn.disabled = false;
  }

  refreshLocale(): void {
    this.modelSelect.title = t().toolbar.modelTitle;
    this.agentSelect.title = t().toolbar.agentTitle;
    this.effortSelect.title = t().toolbar.effortTitle;
    this.updateModels(this.modelOptions, this.currentModel);
    this.updateEffort([
      { value: 'default', label: t().toolbar.effort.default },
      { value: 'low', label: t().toolbar.effort.low },
      { value: 'medium', label: t().toolbar.effort.medium },
      { value: 'high', label: t().toolbar.effort.high },
    ], this.effortSelect.value);
    this.setSending(this.sending);
  }
}
