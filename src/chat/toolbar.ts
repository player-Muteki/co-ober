import { setIcon } from 'obsidian';
import { t, onLocaleChange } from '../i18n/index';
import { normalizeEffortLabel } from './effortLabel';
import type { ExtraConfigOption } from './configOptions';

export interface ToolbarCallbacks {
  onAgentChange?: (agent: string) => void;
  onModelChange?: (model: string) => void;
  onEffortChange?: (effort: string) => void;
  /** A config option this client has no dedicated control for (reasoning budget, persona…). */
  onConfigChange?: (configId: string, value: string) => void;
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
  private currentModelLabel: string | undefined;

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

  // Generic config-option chips (anything the agent offers beyond model/mode/effort)
  private extraConfigsEl: HTMLDivElement;
  private extraConfigs: ExtraConfigOption[] = [];

  // Image attach button
  private attachBtnEl: HTMLButtonElement;
  // Two distinct reasons the paperclip can be dark: the agent is connected but
  // has not promised images, or nothing is connected at all. The drop/paste gate
  // already splits the two (dragDropManager.imageNoAgent vs imageNotSupported);
  // a tooltip that said "no image-capable agent is connected" over a plain
  // disconnect was certifying a negotiation the code never observed.
  private attachDisabledReason: 'unsupported' | 'no-agent' | null = null;

  private readonly unsubscribeLocale: () => void;
  // Close fns registered by wireDropdown, keyed by the selector container.
  private readonly dropdownClosers = new Map<HTMLElement, () => void>();
  private readonly domDisposers: Array<() => void> = [];
  // The document this toolbar was built in: a popped-out view answers to its own
  // window, and a bare `document` read the main one (dropdowns then never closed
  // and arrow navigation indexed the wrong list).
  private readonly doc: Document;

  constructor(container: HTMLDivElement, private callbacks: ToolbarCallbacks) {
    container.addClass('co-ober-toolbar');
    this.doc = container.ownerDocument ?? activeDocument;
    this.unsubscribeLocale = onLocaleChange(() => this.refreshLocale());

    // ── Single row ──
    const row = container.createDiv({ cls: 'co-ober-toolbar-row' });

    // Custom model selector (hover + keyboard dropdown)
    this.modelSelectorEl = row.createDiv({ cls: 'co-ober-model-selector' });
    this.modelBtnEl = this.modelSelectorEl.createDiv({ cls: 'co-ober-model-btn' });
    this.modelLabelEl = this.modelBtnEl.createSpan({ cls: 'co-ober-model-label' });
    this.modelLabelEl.setText(t().toolbar.noModels);
    this.modelDropdownEl = this.modelSelectorEl.createDiv({ cls: 'co-ober-model-dropdown' });
    this.modelDropdownEl.setAttribute('role', 'listbox');
    this.wireDropdown(this.modelSelectorEl, this.modelBtnEl, this.modelDropdownEl, '.co-ober-model-option:not(.empty)', () => this.modelOptions.length > 0);
    // A chooser only once there is something to choose. With no models reported
    // the button still carried role=button, a tab stop and aria-haspopup=listbox,
    // advertising a listbox whose only row is a non-activatable "No models" line.
    this.applyModelOperability();

    // Mode cycle button (click or Enter/Space to cycle, once there is a cycle to make)
    this.modeCycleEl = row.createDiv({ cls: 'co-ober-mode-cycle' });
    this.modeCycleLabelEl = this.modeCycleEl.createSpan({ cls: 'co-ober-mode-cycle-label' });
    this.modeCycleLabelEl.setText('—');
    this.modeCycleEl.addEventListener('click', () => this.cycleMode());
    this.wireActivationKeys(this.modeCycleEl, () => this.cycleMode());
    this.applyModeOperability();

    // Custom effort selector (hover + keyboard dropdown)
    this.effortSelectorEl = row.createDiv({ cls: 'co-ober-effort-selector' });
    this.effortBtnEl = this.effortSelectorEl.createDiv({ cls: 'co-ober-effort-btn' });
    this.effortLabelEl = this.effortBtnEl.createSpan({ cls: 'co-ober-effort-label' });
    this.effortLabelEl.setText('—');
    this.effortDropdownEl = this.effortSelectorEl.createDiv({ cls: 'co-ober-effort-dropdown' });
    this.effortDropdownEl.setAttribute('role', 'listbox');
    this.wireDropdown(this.effortSelectorEl, this.effortBtnEl, this.effortDropdownEl, '.co-ober-effort-option:not(.empty)', () => this.effortOptions.length > 0);
    // Same as the model button above: nothing offered means nothing to pick, so
    // the button must not advertise an expandable listbox.
    this.applyEffortOperability();

    // Generic controls for config options this client has no dedicated control for.
    this.extraConfigsEl = row.createDiv({ cls: 'co-ober-extra-configs' });

    // Permission toggle (click or Enter/Space to cycle)
    this.permToggleEl = row.createDiv({ cls: 'co-ober-perm-toggle' });
    this.permToggleEl.setAttribute('role', 'button');
    this.permToggleEl.setAttribute('tabindex', '0');
    this.permLabelEl = this.permToggleEl.createSpan({ cls: 'co-ober-perm-label' });
    this.permToggleEl.addEventListener('click', () => this.cyclePermission());
    this.wireActivationKeys(this.permToggleEl, () => this.cyclePermission());
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
    this.sendBtn.setAttribute('aria-label', t().toolbar.sendAria);
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
    // A tier the session never named is not the first tier on the list. The
    // bar reads as the prompt's own header, so naming options[0] here claimed a
    // mode the agent never confirmed and sent the reader into a turn under a
    // tier they had not chosen.
    this.modeCycleLabelEl.setText(selected?.label ?? (options.length > 0 ? t().toolbar.unset : '—'));
    this.applyModeOperability();
  }

  /**
   * Present the mode chip as whatever it actually is right now. With two or more
   * agents to switch between it is a cycle button: focusable, pointer, labelled.
   * With one agent (or none yet) cycleMode() can only return, so a button role,
   * a tabindex into the tab order and a pointer cursor were all advertising a
   * click that changed nothing — the reader was invited to press a control that
   * could not answer. The label stays as a plain readout of the agent in force.
   */
  private applyModeOperability(): void {
    const operable = this.modeOptions.length > 1;
    this.modeCycleEl.classList.toggle('has-options', operable);
    if (operable) {
      this.modeCycleEl.setAttribute('role', 'button');
      this.modeCycleEl.setAttribute('tabindex', '0');
      this.modeCycleEl.setAttribute('aria-label', t().toolbar.agentTitle);
    } else {
      this.modeCycleEl.removeAttribute('role');
      this.modeCycleEl.removeAttribute('tabindex');
      this.modeCycleEl.removeAttribute('aria-label');
    }
  }

  /**
   * Advertise the model button as a chooser only when there is a choice to make.
   * The dropdown's empty state is a single non-activatable "No models" row, so
   * `role=button` + `aria-haspopup=listbox` + a tab stop were promising a listbox
   * a reader could open but never select from — the mode chip's rule (above),
   * read across the picker. With models present it is a real button again.
   */
  private applyModelOperability(): void {
    const operable = this.modelOptions.length > 0;
    this.modelSelectorEl.classList.remove('open');
    // The static aria attrs are withdrawn below, but the click/key listeners and
    // the CSS live on the selector; has-options is what scopes pointer and the
    // hover-pop to the case with a listbox to actually open — the mode chip's
    // contract (applyModeOperability), read across the picker.
    this.modelSelectorEl.classList.toggle('has-options', operable);
    if (operable) {
      this.modelBtnEl.setAttribute('role', 'button');
      this.modelBtnEl.setAttribute('tabindex', '0');
      this.modelBtnEl.setAttribute('aria-haspopup', 'listbox');
      this.modelBtnEl.setAttribute('aria-expanded', 'false');
    } else {
      this.modelBtnEl.removeAttribute('role');
      this.modelBtnEl.removeAttribute('tabindex');
      this.modelBtnEl.removeAttribute('aria-haspopup');
      this.modelBtnEl.removeAttribute('aria-expanded');
    }
  }

  /** The effort picker, under the same rule as the model picker. */
  private applyEffortOperability(): void {
    const operable = this.effortOptions.length > 0;
    this.effortSelectorEl.classList.remove('open');
    this.effortSelectorEl.classList.toggle('has-options', operable);
    if (operable) {
      this.effortBtnEl.setAttribute('role', 'button');
      this.effortBtnEl.setAttribute('tabindex', '0');
      this.effortBtnEl.setAttribute('aria-haspopup', 'listbox');
      this.effortBtnEl.setAttribute('aria-expanded', 'false');
    } else {
      this.effortBtnEl.removeAttribute('role');
      this.effortBtnEl.removeAttribute('tabindex');
      this.effortBtnEl.removeAttribute('aria-haspopup');
      this.effortBtnEl.removeAttribute('aria-expanded');
    }
  }

  cycleMode(): boolean {
    if (this.modeOptions.length <= 1) return false;
    const idx = this.modeOptions.findIndex(o => o.value === this.currentMode);
    const next = this.modeOptions[(idx + 1) % this.modeOptions.length];
    this.currentMode = next.value;
    this.modeCycleLabelEl.setText(next.label);
    this.callbacks.onAgentChange?.(next.value);
    return true;
  }

  cycleModeReverse(): boolean {
    if (this.modeOptions.length <= 1) return false;
    const idx = this.modeOptions.findIndex(o => o.value === this.currentMode);
    // Nothing is named as current, so stepping back has to come in at the end
    // of the list — the same place the forward press enters at its start.
    // Against the raw index that absence is -1, which landed the reader on the
    // second-to-last tier, one short of the wrap every other press performs.
    const prev = idx < 0
      ? this.modeOptions[this.modeOptions.length - 1]
      : this.modeOptions[(idx - 1 + this.modeOptions.length) % this.modeOptions.length];
    this.currentMode = prev.value;
    this.modeCycleLabelEl.setText(prev.label);
    this.callbacks.onAgentChange?.(prev.value);
    return true;
  }

  // ── Model custom dropdown ──

  updateModels(options: Array<{ value: string; label: string }>, current?: string, currentLabel?: string): void {
    this.modelOptions = [...options];
    this.currentModel = current;
    this.currentModelLabel = currentLabel;
    this.renderModelDropdown();

    this.modelLabelEl.setText(this.modelLabelText());
    this.applyModelOperability();
  }

  /**
   * The model selector's one-line reading of what is in force. A current the
   * agent reported but the reader hid from the common list is still the model
   * running, so it is named even when the selectable list is empty — claiming
   * "no model" over one that is in force contradicts the dropdown's own rule
   * (a populated list that omits the current still names it). Only a current
   * of undefined earns a no-selection line, and the two empty cases differ:
   * nothing reported against an empty list reads "No model yet" (the same
   * not-yet-surveyed ruling the 0.2.44 stage B slash no-arg branch and the
   * 0.2.42 stage C settings branch both arrived at on the same wire-shape
   * — `state.availableModels` defaults to `[]`, and no config chunk has yet
   * written it), while an empty selectable list against a populated report
   * reads "Not set" — the inventory exists, nothing has been picked.
   */
  private modelLabelText(): string {
    const named = this.modelOptions.find(o => o.value === this.currentModel)?.label
      ?? (this.currentModel ? this.currentModelLabel ?? this.currentModel : null);
    if (named) return named;
    return this.modelOptions.length === 0 ? t().toolbar.noModels : t().toolbar.unset;
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

    // This branch used to name options[0] whenever no tier was confirmed, so
    // the line above it — "no tier is named as the current one" — described an
    // intention the label never kept: a dropped agent, or a session that has
    // not reported its effort yet, still read "Default" as though it were in
    // force for the next prompt.
    const selected = options.find(o => o.value === current);
    this.effortLabelEl.setText(selected?.label ?? (options.length > 0 ? t().toolbar.unset : '—'));
    this.applyEffortOperability();
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

  // ── Generic config options ──

  /**
   * Draw one cycle chip per agent-declared option this client has no dedicated
   * control for. Callers decide what is worth a control (see
   * projectGenericConfigOptions); an empty list clears the row.
   */
  updateExtraConfigs(options: ExtraConfigOption[]): void {
    this.extraConfigs = [...options];
    this.renderExtraConfigs();
  }

  private renderExtraConfigs(): void {
    this.extraConfigsEl.empty();
    for (const opt of this.extraConfigs) {
      const chip = this.extraConfigsEl.createDiv({ cls: 'co-ober-config-chip' });
      chip.setAttribute('role', 'button');
      chip.setAttribute('tabindex', '0');
      const labelEl = chip.createSpan({ cls: 'co-ober-config-chip-label' });
      const hint = this.configHint(opt);
      chip.setAttribute('title', hint);
      chip.setAttribute('aria-label', hint);
      labelEl.setText(`${opt.label}: ${this.configValueLabel(opt)}`);
      const cycle = (): void => {
        const idx = opt.values.findIndex((v) => v.value === opt.value);
        const next = opt.values[(idx + 1) % opt.values.length];
        opt.value = next.value;
        labelEl.setText(`${opt.label}: ${next.label}`);
        const updated = this.configHint(opt);
        chip.setAttribute('title', updated);
        chip.setAttribute('aria-label', updated);
        this.callbacks.onConfigChange?.(opt.id, next.value);
      };
      chip.addEventListener('click', cycle);
      this.wireActivationKeys(chip, cycle);
    }
  }

  private configValueLabel(opt: ExtraConfigOption): string {
    // Nothing reported as current is not a chosen blank value — an empty string
    // rendered beside the name would read as a selection. Say "unset", the word
    // the model and effort selectors already use for the same absence. A
    // non-empty value the list omits is still named, since the agent really is
    // running with it.
    if (opt.value === '') return t().toolbar.unset;
    return opt.values.find((v) => v.value === opt.value)?.label ?? opt.value;
  }

  private configHint(opt: ExtraConfigOption): string {
    return t().toolbar.configTitle
      .replace('{name}', opt.label)
      .replace('{value}', this.configValueLabel(opt));
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
    const label = labels[this.currentPermission] ?? t().toolbar.permSafe;
    this.permLabelEl.setText(label);
    // The tooltip named the internal id while the word beside it named the mode
    // in the reader's own language, so a Chinese UI hovered the button and was
    // told "yolo" — the mode is not a name the user chose, it is the tier the
    // next tool call will run under.
    const hint = t().toolbar.permTitle.replace('{mode}', label);
    this.permToggleEl.setAttribute('title', hint);
    this.permToggleEl.setAttribute('aria-label', hint);
    this.permToggleEl.className = 'co-ober-perm-toggle';
    this.permToggleEl.addClass(`mod-${this.currentPermission}`);
  }

  // ── Keyboard-accessible dropdown helpers ──

  private wireDropdown(
    selectorEl: HTMLElement,
    btnEl: HTMLElement,
    dropdownEl: HTMLElement,
    optionSelector: string,
    canOpen: () => boolean,
  ): void {
    const isOpen = (): boolean => selectorEl.classList.contains('open');
    const open = (): void => {
      // A withdrawn picker (no selectable rows) stays shut: opening would stamp
      // aria-expanded="true" onto a role-less button and reveal a listbox holding
      // only the non-activatable "No models"/"—" row — the empty-listbox lie the
      // operability withdrawal was meant to stop, still reachable by mouse.
      if (!canOpen()) return;
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
      const idx = items.indexOf(this.doc.activeElement as HTMLElement);
      const next = e.key === 'ArrowDown'
        ? items[(idx + 1) % items.length]
        : items[(idx - 1 + items.length) % items.length];
      next.focus();
    });
    // Clicking or focusing outside closes the dropdown.
    const outside = (ev: Event): void => {
      if (!selectorEl.contains(ev.target as Node)) close();
    };
    const doc = this.doc;
    doc.addEventListener('click', outside);
    this.domDisposers.push(() => doc.removeEventListener('click', outside));
    selectorEl.addEventListener('focusout', (ev) => {
      const next = ev.relatedTarget as Node | null;
      if (next && !selectorEl.contains(next)) close();
    });
  }

  private wireOptionKeys(optionEl: HTMLElement, activate: () => void): void {
    this.wireActivationKeys(optionEl, activate);
  }

  /** A div[role=button] must answer the same activation keys a real button does. */
  private wireActivationKeys(el: HTMLElement, activate: () => void): void {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    });
  }

  setImageAttachEnabled(
    enabled: boolean,
    reason: 'unsupported' | 'no-agent' = 'unsupported',
  ): void {
    this.attachBtnEl.disabled = !enabled;
    this.attachBtnEl.classList.toggle('is-disabled', !enabled);
    this.attachDisabledReason = enabled ? null : reason;
    this.attachBtnEl.title = this.attachTitle();
  }

  private attachTitle(): string {
    if (this.attachDisabledReason === 'no-agent') return t().toolbar.attachImageNoAgent;
    if (this.attachDisabledReason === 'unsupported') return t().toolbar.attachImageUnsupported;
    return t().toolbar.attachImage;
  }

  // ── Sending state ──

  setSending(on: boolean): void {
    this.sending = on;
    this.sendBtn.empty();
    setIcon(this.sendBtn, on ? 'square' : 'send');
    this.sendBtn.classList.toggle('mod-stop', on);
    this.sendBtn.setAttribute('aria-label', on ? t().toolbar.stopAria : t().toolbar.sendAria);
    this.sendBtn.disabled = false;
  }

  // ── Locale refresh ──

  refreshLocale(): void {
    // Re-spoke from the same rule updateModels uses, so a language switch can
    // never relabel a model that is in force as "No models" (an empty list with
    // a hidden current) or name a tier nobody reported.
    this.modelLabelEl.setText(this.modelLabelText());
    this.renderModelDropdown();
    this.applyModelOperability();
    const selected = this.modeOptions.find(o => o.value === this.currentMode);
    this.modeCycleLabelEl.setText(selected?.label ?? (this.modeOptions.length > 0 ? t().toolbar.unset : '—'));
    this.applyModeOperability();
    this.updatePermissionDisplay();
    this.attachBtnEl.title = this.attachTitle();
    // Relabel the options the agent actually offered (custom tiers like
    // minimal/xhigh would otherwise vanish under a hardcoded 4-tier list);
    // agent-supplied names for unknown values pass through unchanged. An empty
    // list stays empty: a live session always reaches here with either the
    // agent's tiers or our built-in defaults, so the only time it is bare is a
    // disconnected tab, and re-minting defaults there would hand back the dead
    // control the disconnect just withdrew the moment the reader changed language.
    this.updateEffort(
      this.effortOptions.map((o) => ({ value: o.value, label: normalizeEffortLabel(o.value, o.label) })),
      this.currentEffort,
    );
    // The option names are the agent's own, but the tooltip around them is not.
    this.renderExtraConfigs();
    this.setSending(this.sending);
  }
}
