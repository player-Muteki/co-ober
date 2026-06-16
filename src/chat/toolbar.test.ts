// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { setLocale } from '../i18n/index';
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
    expect(container.querySelector('.co-ober-send-btn')?.textContent).toBe('Stop');

    setLocale('zh');
    toolbar.refreshLocale();

    expect(container.querySelector('.co-ober-model-label')?.textContent).toBe('无可用模型');
    expect(container.querySelector('.co-ober-effort-label')?.textContent).toBe('默认');
    expect(container.querySelector('.co-ober-effort-option')?.textContent).toBe('默认');
    expect(container.querySelector('.co-ober-send-btn')?.textContent).toBe('停止');
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
