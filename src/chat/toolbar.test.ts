// @vitest-environment happy-dom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { setLocale, t } from '../i18n/index';
import { InputToolbar } from './toolbar';
import { installObsidianDomHelpers } from '../test/domHelpers';

installObsidianDomHelpers();

describe('InputToolbar locale refresh', () => {
  it('updates model label, effort labels, and send state', () => {
    setLocale('en');
    const container = document.createElement('div') as HTMLDivElement;
    const toolbar = new InputToolbar(container, {});

    toolbar.updateModels([]);
    toolbar.setSending(true);

    // Custom model selector - label shows "No models" when empty
    expect(container.querySelector('.co-ober-model-label')?.textContent).toBe('No models');
    expect(container.querySelector('.co-ober-send-btn')?.classList.contains('mod-stop')).toBe(true);

    setLocale('zh');
    toolbar.refreshLocale();

    expect(container.querySelector('.co-ober-model-label')?.textContent).toBe('无可用模型');
    // An empty effort list stays withdrawn across a locale switch. Nothing was
    // negotiating tiers, so an explicit pick has no client to reach — the same
    // dead affordance the disconnect path now empties. This used to fall back to
    // re-minting the built-in defaults (and once even named 默认 as selected);
    // refreshLocale now maps the real (empty) list, so the picker offers nothing
    // and the label reports none, exactly as the models row reads "No models".
    expect(container.querySelector('.co-ober-effort-label')?.textContent).toBe('—');
    const effortOptions = Array.from(container.querySelectorAll('.co-ober-effort-option'))
      .filter((el) => !el.classList.contains('empty'));
    expect(effortOptions).toHaveLength(0);
    expect(container.querySelector('.co-ober-send-btn')?.classList.contains('mod-stop')).toBe(true);
  });

  it('names no tier after a locale switch that never named one', () => {
    setLocale('en');
    const container = document.createElement('div') as HTMLDivElement;
    const toolbar = new InputToolbar(container, {});
    // The three controls agree on what an unconfirmed selection looks like:
    // the list is offered, the label says nothing on it is in force.
    toolbar.updateModels(
      [
        { value: 'openai/gpt-4', label: 'GPT-4' },
        { value: 'anthropic/claude', label: 'Claude' },
      ],
      undefined,
    );
    toolbar.updateAgents([{ value: 'build', label: 'Build' }], 'ask');
    toolbar.updateEffort(
      [
        { value: 'default', label: 'Default' },
        { value: 'high', label: 'High' },
      ],
      undefined,
    );

    expect(container.querySelector('.co-ober-model-label')?.textContent).toBe(t().toolbar.unset);
    // A current the agent reported that is not on the list is not a choice
    // either: the bar cannot name a tier the session never offered.
    expect(container.querySelector('.co-ober-mode-cycle-label')?.textContent).toBe(t().toolbar.unset);
    expect(container.querySelector('.co-ober-effort-label')?.textContent).toBe(t().toolbar.unset);
    // The dropdown still marks nothing as chosen, which is the other half of
    // the same claim.
    expect(container.querySelector('.co-ober-model-option.selected')).toBeNull();
    expect(container.querySelector('.co-ober-effort-option.selected')).toBeNull();

    setLocale('zh');
    toolbar.refreshLocale();
    expect(container.querySelector('.co-ober-model-label')?.textContent).toBe('未设定');
    expect(container.querySelector('.co-ober-effort-label')?.textContent).toBe('未设定');
    setLocale('en');
  });

  it('still names the tier the session did report', () => {
    setLocale('en');
    const container = document.createElement('div') as HTMLDivElement;
    const toolbar = new InputToolbar(container, {});
    toolbar.updateModels(
      [
        { value: 'openai/gpt-4', label: 'GPT-4' },
        { value: 'anthropic/claude', label: 'Claude' },
      ],
      'anthropic/claude',
    );
    toolbar.updateEffort(
      [
        { value: 'default', label: 'Default' },
        { value: 'high', label: 'High' },
      ],
      'high',
    );

    expect(container.querySelector('.co-ober-model-label')?.textContent).toBe('Claude');
    expect(container.querySelector('.co-ober-effort-label')?.textContent).toBe('High');
  });

  it('names a model the agent reported even though the common list hides it', () => {
    setLocale('en');
    const container = document.createElement('div') as HTMLDivElement;
    const toolbar = new InputToolbar(container, {});
    // The picker is filtered to the reader's common models, but the session is
    // actually running a model that filter dropped. The controller still hands
    // over that model and its name, so the bar tells the truth about what is in
    // force rather than claiming "Not set" — the only nothing-set reading is an
    // agent that reported no model at all.
    toolbar.updateModels(
      [{ value: 'openai/gpt-4', label: 'GPT-4' }],
      'anthropic/claude',
      'Claude',
    );
    expect(container.querySelector('.co-ober-model-label')?.textContent).toBe('Claude');
    // The hidden model is not offered, so the dropdown marks nothing as chosen.
    expect(container.querySelector('.co-ober-model-option.selected')).toBeNull();

    // A locale repaint re-reads the same truth instead of dropping back to unset.
    setLocale('zh');
    toolbar.refreshLocale();
    expect(container.querySelector('.co-ober-model-label')?.textContent).toBe('Claude');
    setLocale('en');
  });

  it('keeps the send button aria-label in sync with its icon and locale', () => {
    setLocale('en');
    const container = document.createElement('div') as HTMLDivElement;
    const toolbar = new InputToolbar(container, {});

    expect(container.querySelector('.co-ober-send-btn')?.getAttribute('aria-label')).toBe('Send message');
    toolbar.setSending(true);
    expect(container.querySelector('.co-ober-send-btn')?.getAttribute('aria-label')).toBe('Stop generation');

    setLocale('zh');
    // refreshLocale re-runs setSending, so the aria label follows too.
    toolbar.refreshLocale();
    expect(container.querySelector('.co-ober-send-btn')?.getAttribute('aria-label')).toBe('停止生成');
    toolbar.setSending(false);
    expect(container.querySelector('.co-ober-send-btn')?.getAttribute('aria-label')).toBe('发送消息');
    setLocale('en');
  });
});

describe('InputToolbar effort locale refresh', () => {
  it('keeps agent-offered tiers (including custom ones) when the locale changes', () => {
    setLocale('en');
    const container = document.createElement('div') as HTMLDivElement;
    const toolbar = new InputToolbar(container, {});
    toolbar.updateEffort(
      [
        { value: 'minimal', label: 'Minimal' },
        { value: 'x_high', label: 'Extra high' },
        { value: 'turbo', label: 'Turbo Mode' },
      ],
      'turbo',
    );

    setLocale('zh');
    toolbar.refreshLocale();

    const labels = Array.from(container.querySelectorAll('.co-ober-effort-option')).map((el) => el.textContent);
    expect(labels).toEqual(['最低', '极高', 'Turbo Mode']);
    expect(container.querySelector('.co-ober-effort-label')?.textContent).toBe('Turbo Mode');
    setLocale('en');
  });

  it('keeps an emptied effort list withdrawn across a locale refresh', () => {
    setLocale('en');
    const container = document.createElement('div') as HTMLDivElement;
    const toolbar = new InputToolbar(container, {});
    toolbar.updateEffort(
      [
        { value: 'default', label: 'Default' },
        { value: 'high', label: 'High' },
      ],
      undefined,
    );
    // Disconnect empties the list; a live tab always reaches refreshLocale with
    // the agent's tiers or the built-in defaults, so bare means nothing is negotiating.
    toolbar.updateEffort([], undefined);
    const btn = container.querySelector('.co-ober-effort-btn') as HTMLElement;
    expect(btn.hasAttribute('role')).toBe(false);

    setLocale('zh');
    toolbar.refreshLocale();

    // A language switch must not resurrect the default tiers for a dead agent,
    // nor hand back a picker whose change silently no-ops.
    expect(container.querySelector('.co-ober-effort-label')?.textContent).toBe('—');
    const realOptions = Array.from(container.querySelectorAll('.co-ober-effort-option'))
      .filter((el) => !el.classList.contains('empty'));
    expect(realOptions).toHaveLength(0);
    expect(btn.hasAttribute('role')).toBe(false);
    setLocale('en');
  });
});

describe('InputToolbar image attach', () => {
  it('renders an attach button that fires onAttachImage', () => {
    setLocale('en');
    const container = document.createElement('div') as HTMLDivElement;
    const onAttachImage = vi.fn();
    new InputToolbar(container, { onAttachImage });

    const btn = container.querySelector('.co-ober-attach-btn') as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    expect(btn!.title).toBe('Attach image');
    btn!.click();
    expect(onAttachImage).toHaveBeenCalledTimes(1);
  });

  it('localizes the attach tooltip on refreshLocale', () => {
    setLocale('en');
    const container = document.createElement('div') as HTMLDivElement;
    const toolbar = new InputToolbar(container, {});
    toolbar.refreshLocale();
    setLocale('zh');
    toolbar.refreshLocale();

    const btn = container.querySelector('.co-ober-attach-btn') as HTMLButtonElement;
    expect(btn.title).toBe('添加图片');
    setLocale('en');
  });
});

describe('InputToolbar cycle mode', () => {
  it('cycleMode advances to next agent and wraps around', () => {
    const container = document.createElement('div') as HTMLDivElement;
    const onAgentChange = vi.fn();
    const toolbar = new InputToolbar(container, { onAgentChange });

    toolbar.updateAgents([
      { value: 'build', label: 'Build' },
      { value: 'ask', label: 'Ask' },
    ], 'build');

    toolbar.cycleMode();
    expect(onAgentChange).toHaveBeenCalledWith('ask');
    expect(container.querySelector('.co-ober-mode-cycle-label')?.textContent).toBe('Ask');

    toolbar.cycleMode();
    expect(onAgentChange).toHaveBeenCalledWith('build');
    expect(container.querySelector('.co-ober-mode-cycle-label')?.textContent).toBe('Build');
  });

  it('reports whether a cycle actually moved, so the caller may release the key', () => {
    // The composer's Tab handler only swallows the key when a mode changed.
    // At one agent (or none yet) cycleMode can only return, so it must say
    // "no" — false — and let Tab keep doing what Tab does everywhere else.
    const container = document.createElement('div') as HTMLDivElement;
    const toolbar = new InputToolbar(container, { onAgentChange: vi.fn() });

    toolbar.updateAgents([{ value: 'build', label: 'Build' }], 'build');
    expect(toolbar.cycleMode()).toBe(false);
    expect(toolbar.cycleModeReverse()).toBe(false);

    toolbar.updateAgents([{ value: 'build', label: 'Build' }, { value: 'ask', label: 'Ask' }], 'build');
    expect(toolbar.cycleMode()).toBe(true);
    expect(toolbar.cycleModeReverse()).toBe(true);
  });

  it('cycleModeReverse goes to previous agent and wraps around', () => {
    const container = document.createElement('div') as HTMLDivElement;
    const onAgentChange = vi.fn();
    const toolbar = new InputToolbar(container, { onAgentChange });

    toolbar.updateAgents([
      { value: 'build', label: 'Build' },
      { value: 'ask', label: 'Ask' },
    ], 'build');

    toolbar.cycleModeReverse();
    expect(onAgentChange).toHaveBeenCalledWith('ask');

    toolbar.cycleModeReverse();
    expect(onAgentChange).toHaveBeenCalledWith('build');
  });

  it('enters the cycle at the end when nothing is named as current', () => {
    const container = document.createElement('div') as HTMLDivElement;
    const onAgentChange = vi.fn();
    const toolbar = new InputToolbar(container, { onAgentChange });

    toolbar.updateAgents(
      [
        { value: 'build', label: 'Build' },
        { value: 'ask', label: 'Ask' },
        { value: 'plan', label: 'Plan' },
      ],
      undefined,
    );

    // Backwards from "nothing selected" used to land on the second-to-last
    // tier: the missing selection is index -1, and the wrap arithmetic stepped
    // off the end of the list by one. Forward enters at the start, so back has
    // to enter at the end, or the two directions disagree about where an
    // unselected bar starts.
    toolbar.cycleModeReverse();
    expect(onAgentChange).toHaveBeenCalledWith('plan');
    expect(container.querySelector('.co-ober-mode-cycle-label')?.textContent).toBe('Plan');

    toolbar.cycleModeReverse();
    expect(onAgentChange).toHaveBeenCalledWith('ask');
  });

  it('enters the cycle at the start when nothing is named as current', () => {
    const container = document.createElement('div') as HTMLDivElement;
    const onAgentChange = vi.fn();
    const toolbar = new InputToolbar(container, { onAgentChange });

    toolbar.updateAgents(
      [
        { value: 'build', label: 'Build' },
        { value: 'ask', label: 'Ask' },
        { value: 'plan', label: 'Plan' },
      ],
      undefined,
    );

    toolbar.cycleMode();
    expect(onAgentChange).toHaveBeenCalledWith('build');
  });

  it('does not cycle with single agent', () => {
    const container = document.createElement('div') as HTMLDivElement;
    const onAgentChange = vi.fn();
    const toolbar = new InputToolbar(container, { onAgentChange });

    toolbar.updateAgents([
      { value: 'build', label: 'Build' },
    ], 'build');

    toolbar.cycleMode();
    expect(onAgentChange).not.toHaveBeenCalled();

    toolbar.cycleModeReverse();
    expect(onAgentChange).not.toHaveBeenCalled();
  });
});

describe('InputToolbar permission cycle', () => {
  it('cycles safe -> readonly -> plan -> yolo -> safe via the toggle', () => {
    const container = document.createElement('div') as HTMLDivElement;
    const onPermissionChange = vi.fn();
    new InputToolbar(container, { onPermissionChange });
    const toggle = container.querySelector('.co-ober-perm-toggle') as HTMLElement;
    expect(toggle).not.toBeNull();

    const expected: Array<[string, string]> = [
      ['readonly', '🛡️ Readonly'],
      ['plan', '📋 Plan'],
      ['yolo', '⚡ Yolo'],
      ['safe', '🔒 Safe'],
    ];
    for (const [mode, label] of expected) {
      toggle.click();
      expect(onPermissionChange).toHaveBeenLastCalledWith(mode);
      expect(container.querySelector('.co-ober-perm-label')?.textContent).toBe(label);
    }
    expect(onPermissionChange).toHaveBeenCalledTimes(4);
  });

  it('updatePermission sets the display without emitting a change', () => {
    const container = document.createElement('div') as HTMLDivElement;
    const onPermissionChange = vi.fn();
    const toolbar = new InputToolbar(container, { onPermissionChange });

    toolbar.updatePermission('readonly');

    expect(onPermissionChange).not.toHaveBeenCalled();
    expect(container.querySelector('.co-ober-perm-label')?.textContent).toBe('🛡️ Readonly');
    expect(container.querySelector('.co-ober-perm-toggle')?.classList.contains('mod-readonly')).toBe(true);
  });

  it('names the tier in the tooltip in the language the button speaks', () => {
    const container = document.createElement('div') as HTMLDivElement;
    const toolbar = new InputToolbar(container, {});

    setLocale('zh');
    try {
      toolbar.updatePermission('yolo');
      const toggle = container.querySelector('.co-ober-perm-toggle') as HTMLElement;
      // The label read 放行 while the tooltip read 权限模式：yolo — an internal id
      // no reader chose, standing in for the tier the next tool call runs under.
      expect(toggle.getAttribute('title')).toBe(
        t().toolbar.permTitle.replace('{mode}', t().toolbar.permYolo),
      );
      expect(toggle.getAttribute('title')).not.toContain('yolo');
      expect(toggle.getAttribute('aria-label')).toBe(toggle.getAttribute('title'));
    } finally {
      setLocale('en');
    }
  });
});

describe('InputToolbar cycle button a11y', () => {
  it('exposes the mode cycle as a button only once there is a mode to change', () => {
    setLocale('en');
    const container = document.createElement('div') as HTMLDivElement;
    const toolbar = new InputToolbar(container, {});

    const mode = container.querySelector('.co-ober-mode-cycle') as HTMLElement;
    const perm = container.querySelector('.co-ober-perm-toggle') as HTMLElement;

    // One agent offered → cycleMode() can only return, so a button role and a
    // slot in the tab order invited a press that changed nothing.
    toolbar.updateAgents([{ value: 'build', label: 'Build' }], 'build');
    expect(mode.getAttribute('role')).toBeNull();
    expect(mode.getAttribute('tabindex')).toBeNull();
    expect(mode.classList.contains('has-options')).toBe(false);

    // A genuine choice → a genuine cycle control.
    toolbar.updateAgents([{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], 'a');
    expect(mode.getAttribute('role')).toBe('button');
    expect(mode.getAttribute('tabindex')).toBe('0');
    expect(mode.getAttribute('aria-label')).toBe('Agent mode');
    expect(mode.classList.contains('has-options')).toBe(true);

    // The permission toggle always has tiers to move through, so it stays a button.
    expect(perm.getAttribute('role')).toBe('button');
    expect(perm.getAttribute('tabindex')).toBe('0');
    expect(perm.getAttribute('aria-label')).toContain('Permission');
  });

  it('advertises the model and effort pickers as listboxes only once they offer a choice', () => {
    setLocale('en');
    const container = document.createElement('div') as HTMLDivElement;
    const toolbar = new InputToolbar(container, {});

    const model = container.querySelector('.co-ober-model-btn') as HTMLElement;
    const effort = container.querySelector('.co-ober-effort-btn') as HTMLElement;

    // Built with nothing reported: each dropdown's sole row is the non-activatable
    // "No models"/"—" line, so a button role, a tab stop and aria-haspopup=listbox
    // were promising a pickable listbox that a reader could open but never choose
    // from. The mode chip's rule (above), read across the two pickers.
    expect(model.getAttribute('role')).toBeNull();
    expect(model.getAttribute('tabindex')).toBeNull();
    expect(model.getAttribute('aria-haspopup')).toBeNull();
    expect(model.getAttribute('aria-expanded')).toBeNull();
    expect(effort.getAttribute('role')).toBeNull();
    expect(effort.getAttribute('tabindex')).toBeNull();
    expect(effort.getAttribute('aria-haspopup')).toBeNull();

    // Models arrive → the model button is a real expandable chooser again.
    toolbar.updateModels([{ value: 'openai/gpt-4', label: 'GPT-4' }], 'openai/gpt-4');
    expect(model.getAttribute('role')).toBe('button');
    expect(model.getAttribute('tabindex')).toBe('0');
    expect(model.getAttribute('aria-haspopup')).toBe('listbox');
    expect(model.getAttribute('aria-expanded')).toBe('false');

    // Effort arrives → same, and only now; it stayed inert through the model update.
    expect(effort.getAttribute('role')).toBeNull();
    toolbar.updateEffort([{ value: 'high', label: 'High' }], 'high');
    expect(effort.getAttribute('role')).toBe('button');
    expect(effort.getAttribute('tabindex')).toBe('0');
    expect(effort.getAttribute('aria-haspopup')).toBe('listbox');

    // Reported then withdrawn: the chooser goes back to promising nothing.
    toolbar.updateModels([], undefined);
    expect(model.getAttribute('role')).toBeNull();
    expect(model.getAttribute('aria-haspopup')).toBeNull();
    setLocale('en');
  });

  it('Enter and Space activate the cycle controls', () => {
    setLocale('en');
    const container = document.createElement('div') as HTMLDivElement;
    const onAgentChange = vi.fn();
    const onPermissionChange = vi.fn();
    const toolbar = new InputToolbar(container, { onAgentChange, onPermissionChange });
    toolbar.updateAgents([{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], 'a');

    const mode = container.querySelector('.co-ober-mode-cycle') as HTMLElement;
    pressKey(mode, 'Enter');
    expect(onAgentChange).toHaveBeenLastCalledWith('b');
    pressKey(mode, ' ');
    expect(onAgentChange).toHaveBeenLastCalledWith('a');

    const perm = container.querySelector('.co-ober-perm-toggle') as HTMLElement;
    pressKey(perm, 'Enter');
    expect(onPermissionChange).toHaveBeenCalledWith('readonly');
  });

  it('localizes the cycle aria-labels on refreshLocale', () => {
    setLocale('en');
    const container = document.createElement('div') as HTMLDivElement;
    const toolbar = new InputToolbar(container, {});
    // Operable, so the mode chip carries an aria-label worth localizing.
    toolbar.updateAgents([{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], 'a');
    setLocale('zh');
    toolbar.refreshLocale();

    expect(container.querySelector('.co-ober-mode-cycle')?.getAttribute('aria-label')).toBe('Agent 模式');
    expect(container.querySelector('.co-ober-perm-toggle')?.getAttribute('aria-label')).toContain('权限模式');
    setLocale('en');
  });
});

describe('InputToolbar withdrawn picker stays inert', () => {
  it('does not open on click or Enter, and never re-stamps aria-expanded, once the picker is withdrawn', () => {
    // applyModelOperability removes role/tabindex/aria-haspopup on an empty list,
    // but the click and key listeners from wireDropdown survive — so a mouse press
    // called open() anyway, stamping aria-expanded="true" onto a now role-less div
    // and revealing a listbox whose only row is the non-activatable "No models"
    // line. A withdrawn picker must be genuinely shut.
    setLocale('en');
    const container = document.createElement('div') as HTMLDivElement;
    document.body.appendChild(container);
    const toolbar = new InputToolbar(container, {});
    toolbar.updateModels([], undefined);
    const btn = container.querySelector('.co-ober-model-btn') as HTMLElement;
    const selector = container.querySelector('.co-ober-model-selector') as HTMLElement;
    expect(btn.getAttribute('aria-expanded')).toBeNull();

    btn.click();
    expect(selector.classList.contains('open')).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBeNull();

    pressKey(btn, 'Enter');
    expect(selector.classList.contains('open')).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBeNull();

    toolbar.dispose();
    container.remove();
  });

  it('scopes the picker affordance to has-options, as the mode chip scopes its own', () => {
    setLocale('en');
    const container = document.createElement('div') as HTMLDivElement;
    const toolbar = new InputToolbar(container, {});
    const modelSelector = container.querySelector('.co-ober-model-selector') as HTMLElement;
    const effortSelector = container.querySelector('.co-ober-effort-selector') as HTMLElement;
    // Built with nothing reported: pointer + hover-pop are gated on this class, so
    // an empty picker must not wear the look of a control it is not.
    expect(modelSelector.classList.contains('has-options')).toBe(false);
    expect(effortSelector.classList.contains('has-options')).toBe(false);

    toolbar.updateModels([{ value: 'm', label: 'M' }], 'm');
    toolbar.updateEffort([{ value: 'high', label: 'High' }], 'high');
    expect(modelSelector.classList.contains('has-options')).toBe(true);
    expect(effortSelector.classList.contains('has-options')).toBe(true);

    toolbar.updateModels([], undefined);
    toolbar.updateEffort([], undefined);
    expect(modelSelector.classList.contains('has-options')).toBe(false);
    expect(effortSelector.classList.contains('has-options')).toBe(false);
  });
});

function pressKey(target: Element, key: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

describe('InputToolbar attach capability gating', () => {
  it('disables the attach button with an explanatory tooltip when the agent lacks image support', () => {
    setLocale('en');
    const container = document.createElement('div') as HTMLDivElement;
    const onAttachImage = vi.fn();
    const toolbar = new InputToolbar(container, { onAttachImage });

    toolbar.setImageAttachEnabled(false);
    const btn = container.querySelector('.co-ober-attach-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.classList.contains('is-disabled')).toBe(true);
    expect(btn.title).toBe('This agent does not support image prompts');
    btn.click();
    expect(onAttachImage).not.toHaveBeenCalled();

    toolbar.setImageAttachEnabled(true);
    expect(btn.disabled).toBe(false);
    expect(btn.classList.contains('is-disabled')).toBe(false);
    expect(btn.title).toBe('Attach image');
    btn.click();
    expect(onAttachImage).toHaveBeenCalledTimes(1);
  });

  it('keeps the unsupported tooltip localized across locale refreshes', () => {
    setLocale('en');
    const container = document.createElement('div') as HTMLDivElement;
    const toolbar = new InputToolbar(container, {});
    toolbar.setImageAttachEnabled(false);

    setLocale('zh');
    toolbar.refreshLocale();
    const btn = container.querySelector('.co-ober-attach-btn') as HTMLButtonElement;
    expect(btn.title).toBe('当前 Agent 不支持图片提示词');
    expect(btn.disabled).toBe(true);
    setLocale('en');
  });
});

describe('InputToolbar keyboard-accessible dropdowns', () => {
  // happy-dom only tracks document.activeElement for attached elements.
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function modelToolbar(onModelChange = vi.fn()): { toolbar: InputToolbar; container: HTMLDivElement } {
    setLocale('en');
    const container = document.createElement('div') as HTMLDivElement;
    document.body.appendChild(container);
    const toolbar = new InputToolbar(container, { onModelChange });
    toolbar.updateModels(
      [
        { value: 'openai/gpt-4', label: 'GPT-4' },
        { value: 'anthropic/claude', label: 'Claude' },
      ],
      'openai/gpt-4',
    );
    return { toolbar, container };
  }

  it('exposes the model dropdown with listbox semantics', () => {
    const { container } = modelToolbar();
    const btn = container.querySelector('.co-ober-model-btn')!;
    const dropdown = container.querySelector('.co-ober-model-dropdown')!;
    expect(btn.getAttribute('tabindex')).toBe('0');
    expect(btn.getAttribute('aria-haspopup')).toBe('listbox');
    expect(dropdown.getAttribute('role')).toBe('listbox');

    const options = container.querySelectorAll('.co-ober-model-option');
    expect(options).toHaveLength(2);
    expect(options[0].getAttribute('role')).toBe('option');
    expect(options[0].getAttribute('aria-selected')).toBe('true');
    expect(options[1].getAttribute('aria-selected')).toBe('false');
  });

  it('opens with Enter, moves focus to the first option, and fires the callback on Enter activation', () => {
    const onModelChange = vi.fn();
    const { container } = modelToolbar(onModelChange);
    const btn = container.querySelector('.co-ober-model-btn')!;
    const selector = container.querySelector('.co-ober-model-selector')!;

    pressKey(btn, 'Enter');
    expect(selector.classList.contains('open')).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    const options = container.querySelectorAll('.co-ober-model-option');
    expect(document.activeElement).toBe(options[0]);

    pressKey(options[1], 'Enter');
    expect(onModelChange).toHaveBeenCalledWith('anthropic/claude');
    expect(container.querySelector('.co-ober-model-label')?.textContent).toBe('Claude');
    expect(selector.classList.contains('open')).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    const rereadOptions = container.querySelectorAll('.co-ober-model-option');
    expect(rereadOptions[1].getAttribute('aria-selected')).toBe('true');
    expect(rereadOptions[1].classList.contains('selected')).toBe(true);
  });

  it('wraps arrow navigation across options and closes on Escape', () => {
    const { container } = modelToolbar();
    const btn = container.querySelector('.co-ober-model-btn')!;
    const selector = container.querySelector('.co-ober-model-selector')!;
    const options = container.querySelectorAll('.co-ober-model-option');

    pressKey(btn, 'ArrowDown');
    expect(selector.classList.contains('open')).toBe(true);
    expect(document.activeElement).toBe(options[0]);

    pressKey(options[0], 'ArrowDown');
    expect(document.activeElement).toBe(options[1]);
    pressKey(options[1], 'ArrowDown');
    expect(document.activeElement).toBe(options[0]);
    pressKey(options[0], 'ArrowUp');
    expect(document.activeElement).toBe(options[1]);

    pressKey(options[1], 'Escape');
    expect(selector.classList.contains('open')).toBe(false);
    expect(document.activeElement).toBe(btn);
  });

  it('toggles from the pointer and closes on outside clicks', () => {
    const { container } = modelToolbar();
    const btn = container.querySelector('.co-ober-model-btn') as HTMLElement;
    const selector = container.querySelector('.co-ober-model-selector')!;

    btn.click();
    expect(selector.classList.contains('open')).toBe(true);
    btn.click();
    expect(selector.classList.contains('open')).toBe(false);

    btn.click();
    (document.querySelector('body') as HTMLElement).click();
    expect(selector.classList.contains('open')).toBe(false);
  });

  it('makes the effort dropdown keyboard-operable too', () => {
    setLocale('en');
    const container = document.createElement('div') as HTMLDivElement;
    document.body.appendChild(container);
    const onEffortChange = vi.fn();
    const toolbar = new InputToolbar(container, { onEffortChange });
    toolbar.updateEffort(
      [
        { value: 'default', label: 'Default' },
        { value: 'high', label: 'High' },
      ],
      'default',
    );

    const btn = container.querySelector('.co-ober-effort-btn')!;
    const selector = container.querySelector('.co-ober-effort-selector')!;
    pressKey(btn, ' ');
    expect(selector.classList.contains('open')).toBe(true);
    const options = container.querySelectorAll('.co-ober-effort-option');
    expect(document.activeElement).toBe(options[0]);

    pressKey(options[1], 'Enter');
    expect(onEffortChange).toHaveBeenCalledWith('high');
    expect(container.querySelector('.co-ober-effort-label')?.textContent).toBe('High');
    expect(selector.classList.contains('open')).toBe(false);
  });
});

describe('InputToolbar generic config chips', () => {
  const budget = () => ({
    id: 'reasoning_budget',
    label: 'Reasoning',
    value: 'low',
    values: [
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
    ],
  });

  it('shows an agent-declared option the toolbar has no dedicated control for', () => {
    setLocale('en');
    const container = document.createElement('div') as HTMLDivElement;
    const toolbar = new InputToolbar(container, {});
    expect(container.querySelector('.co-ober-extra-configs')).not.toBeNull();
    expect(container.querySelectorAll('.co-ober-config-chip').length).toBe(0);

    toolbar.updateExtraConfigs([budget()]);

    const chip = container.querySelector('.co-ober-config-chip') as HTMLElement;
    expect(chip.querySelector('.co-ober-config-chip-label')?.textContent).toBe('Reasoning: Low');
    expect(chip.getAttribute('role')).toBe('button');
    expect(chip.getAttribute('tabindex')).toBe('0');
    expect(chip.getAttribute('aria-label')).toBe('Reasoning: Low (click to change)');
  });

  it('reports the choice it is making for the user, and wraps around', () => {
    setLocale('en');
    const container = document.createElement('div') as HTMLDivElement;
    const onConfigChange = vi.fn();
    const toolbar = new InputToolbar(container, { onConfigChange });
    toolbar.updateExtraConfigs([budget()]);

    const chip = container.querySelector('.co-ober-config-chip') as HTMLElement;
    chip.click();
    expect(onConfigChange).toHaveBeenLastCalledWith('reasoning_budget', 'high');
    expect(chip.querySelector('.co-ober-config-chip-label')?.textContent).toBe('Reasoning: High');
    expect(chip.getAttribute('title')).toBe('Reasoning: High (click to change)');

    pressKey(chip, ' ');
    expect(onConfigChange).toHaveBeenLastCalledWith('reasoning_budget', 'low');
    expect(chip.querySelector('.co-ober-config-chip-label')?.textContent).toBe('Reasoning: Low');
  });

  it('replaces the previous projection when the agent sends a new one', () => {
    setLocale('en');
    const container = document.createElement('div') as HTMLDivElement;
    const toolbar = new InputToolbar(container, {});
    toolbar.updateExtraConfigs([budget(), { ...budget(), id: 'persona', label: 'Persona' }]);
    expect(container.querySelectorAll('.co-ober-config-chip').length).toBe(2);

    toolbar.updateExtraConfigs([{ id: 'persona', label: 'Persona', value: 'terse', values: [{ value: 'terse', label: 'Terse' }, { value: 'warm', label: 'Warm' }] }]);
    const chips = container.querySelectorAll('.co-ober-config-chip');
    expect(chips.length).toBe(1);
    expect(chips[0].textContent).toBe('Persona: Terse');

    toolbar.updateExtraConfigs([]);
    expect(container.querySelectorAll('.co-ober-config-chip').length).toBe(0);
  });

  it('relables the chip on a locale switch without inventing the agent’s own words', () => {
    setLocale('en');
    const container = document.createElement('div') as HTMLDivElement;
    const toolbar = new InputToolbar(container, {});
    toolbar.updateExtraConfigs([budget()]);

    setLocale('zh');
    toolbar.refreshLocale();

    const chip = container.querySelector('.co-ober-config-chip') as HTMLElement;
    // The option and value names come from the agent, so they stay as sent.
    expect(chip.querySelector('.co-ober-config-chip-label')?.textContent).toBe('Reasoning: Low');
    expect(chip.getAttribute('aria-label')).toBe('Reasoning：Low（点击切换）');
    setLocale('en');
  });
});

describe('InputToolbar dropdown document (0.2.5 stage 3)', () => {
  it('listens for the outside click on the document the toolbar lives in', () => {
    setLocale('en');
    // A second document: reaching for a global here meant the outside click
    // landed on a document that never saw the toolbar, so the dropdown stayed
    // open over whatever the reader did next.
    const other = document.implementation.createHTMLDocument('toolbar');
    const container = other.createElement('div') as unknown as HTMLDivElement;
    other.body.appendChild(container);
    const toolbar = new InputToolbar(container, {});
    toolbar.updateModels([{ value: 'm', label: 'M' }], 'm');

    (container.querySelector('.co-ober-model-btn') as HTMLElement).click();
    expect(container.querySelector('.co-ober-model-selector')?.classList.contains('open')).toBe(true);

    other.body.dispatchEvent(new Event('click', { bubbles: true }));
    expect(container.querySelector('.co-ober-model-selector')?.classList.contains('open')).toBe(false);

    toolbar.dispose();
    container.remove();
    setLocale('en');
  });

  it('stops closing dropdowns once the toolbar is disposed', () => {
    setLocale('en');
    const container = document.createElement('div') as HTMLDivElement;
    document.body.appendChild(container);
    const toolbar = new InputToolbar(container, {});
    toolbar.updateModels([{ value: 'm', label: 'M' }], 'm');

    (container.querySelector('.co-ober-model-btn') as HTMLElement).click();
    expect(container.querySelector('.co-ober-model-selector')?.classList.contains('open')).toBe(true);

    toolbar.dispose();
    // The handler is off the document now, so an outside click no longer reaches
    // a toolbar that has been torn down with the view.
    document.body.dispatchEvent(new Event('click', { bubbles: true }));
    expect(container.querySelector('.co-ober-model-selector')?.classList.contains('open')).toBe(true);
    container.remove();
  });
});
