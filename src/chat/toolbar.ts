export interface ToolbarCallbacks {
  onAgentChange?: (agent: string) => void;
  onModelChange?: (model: string) => void;
  onEffortChange?: (effort: string) => void;
}

export class InputToolbar {
  private agentSelect: HTMLSelectElement;
  private modelSelect: HTMLSelectElement;
  private effortSelect: HTMLSelectElement;
  private sendingEl: HTMLSpanElement;

  constructor(container: HTMLDivElement, private callbacks: ToolbarCallbacks) {
    container.addClass('copsidian-toolbar');

    container.createEl('label', { text: 'Agent: ' }).addClass('tb-label');
    this.agentSelect = container.createEl('select', { cls: 'copsidian-dropdown tb-select' });
    this.agentSelect.onchange = () => this.callbacks.onAgentChange?.(this.agentSelect.value);

    container.createEl('label', { text: 'Model: ' }).addClass('tb-label');
    this.modelSelect = container.createEl('select', { cls: 'copsidian-dropdown tb-select' });
    this.modelSelect.onchange = () => this.callbacks.onModelChange?.(this.modelSelect.value);

    container.createEl('label', { text: 'Effort: ' }).addClass('tb-label');
    this.effortSelect = container.createEl('select', { cls: 'copsidian-dropdown tb-select' });
    this.effortSelect.onchange = () => this.callbacks.onEffortChange?.(this.effortSelect.value);

    this.sendingEl = container.createSpan({ cls: 'copsidian-toolbar-sending', text: '⏳' });
    this.sendingEl.style.display = 'none';
  }

  updateAgents(options: Array<{ value: string; label: string }>, current?: string): void {
    this.agentSelect.empty();
    if (options.length === 0) {
      this.agentSelect.createEl('option', { text: '(none)', value: '' });
    } else {
      for (const o of options) {
        this.agentSelect.createEl('option', { text: o.label, value: o.value });
      }
      if (current) this.agentSelect.value = current;
    }
  }

  updateModels(options: Array<{ value: string; label: string }>, current?: string): void {
    this.modelSelect.empty();
    for (const o of options) {
      this.modelSelect.createEl('option', { text: o.label, value: o.value });
    }
    if (current) this.modelSelect.value = current;
  }

  updateEffort(options: Array<{ value: string; label: string }>, current?: string): void {
    this.effortSelect.empty();
    for (const o of options) {
      this.effortSelect.createEl('option', { text: o.label, value: o.value });
    }
    if (current) this.effortSelect.value = current;
  }

  setSending(on: boolean): void {
    this.sendingEl.style.display = on ? '' : 'none';
  }
}
