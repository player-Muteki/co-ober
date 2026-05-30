// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
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
    expect(container.querySelector('.copsilot-model-label')?.textContent).toBe('No models');
    expect(container.querySelector('.copsilot-send-btn')?.textContent).toBe('Stop');

    setLocale('zh');
    toolbar.refreshLocale();

    expect(container.querySelector('.copsilot-model-label')?.textContent).toBe('无可用模型');
    expect(container.querySelector('.copsilot-effort-label')?.textContent).toBe('默认');
    expect(container.querySelector('.copsilot-effort-option')?.textContent).toBe('默认');
    expect(container.querySelector('.copsilot-send-btn')?.textContent).toBe('停止');
  });
});
