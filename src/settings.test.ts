// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { CopsidianSettingsTab } from './settings';
import { DEFAULT_SETTINGS, VIEW_TYPE } from './types';
import { setLocale } from './i18n/index';
import { installObsidianDomHelpers } from './test/domHelpers';
import type CopsidianPlugin from './main';
import type { CopsidianSettings } from './types';

installObsidianDomHelpers();

describe('CopsidianSettingsTab locale refresh', () => {
  it('redraws settings labels and refreshes open chat views when language changes', async () => {
    setLocale('en');
    const refreshedView = { refreshLocale: vi.fn() };
    const plugin = createPlugin(refreshedView);
    const tab = new CopsidianSettingsTab(plugin);

    tab.display();
    expect(tab.containerEl.textContent).toContain('Connection');
    expect(tab.containerEl.textContent).toContain('Language');

    const languageSelect = [...tab.containerEl.querySelectorAll('select')]
      .find((select) => [...select.options].some((option) => option.value === 'zh')) as HTMLSelectElement | undefined;
    expect(languageSelect).toBeDefined();
    languageSelect!.value = 'zh';
    languageSelect!.dispatchEvent(new Event('change'));
    await flushPromises();

    expect(plugin.settings.language).toBe('zh');
    expect(plugin.savePluginData).toHaveBeenCalled();
    expect(refreshedView.refreshLocale).toHaveBeenCalled();
    expect(tab.containerEl.textContent).toContain('连接');
    expect(tab.containerEl.textContent).toContain('语言');
    expect(tab.containerEl.textContent).not.toContain('Connection');
  });
});

function createPlugin(refreshedView: { refreshLocale: () => void }): CopsidianPlugin {
  const settings: CopsidianSettings = {
    ...DEFAULT_SETTINGS,
    syncRules: DEFAULT_SETTINGS.syncRules.map((rule) => ({ ...rule })),
    mcpServers: [],
    language: 'en',
  };
  return {
    app: {
      workspace: {
        getLeavesOfType: vi.fn((viewType: string) => (
          viewType === VIEW_TYPE ? [{ view: refreshedView }] : []
        )),
      },
    },
    settings,
    savePluginData: vi.fn().mockResolvedValue(undefined),
    initClient: vi.fn().mockResolvedValue(true),
    client: null,
  } as unknown as CopsidianPlugin;
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
