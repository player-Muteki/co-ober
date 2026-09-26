import { describe, expect, it } from 'vitest';
import { getLocale, lookupLocaleString, setLocale, t } from './index';

describe('i18n locale switching', () => {
  it('switches runtime labels between English and Chinese', () => {
    setLocale('en');
    expect(t().settings.appearance.language).toBe('Language');
    expect(t().toolbar.noModels).toBe('No models');
    expect(t().inlineEdit.apply).toBe('Apply');
    expect(t().notice.noSelection).toBe('No text selected');

    setLocale('zh');
    expect(t().settings.appearance.language).toBe('语言');
    expect(t().toolbar.noModels).toBe('无可用模型');
    expect(t().inlineEdit.apply).toBe('应用');
    expect(t().notice.noSelection).toBe('未选择文本');
  });

  it('falls back to English for unknown locales', () => {
    setLocale('unknown');
    expect(t().settings.appearance.language).toBe('Language');
  });

  it('returns the current locale via getLocale', () => {
    setLocale('en');
    expect(getLocale()).toBe(t());
    expect(getLocale().settings.appearance.language).toBe('Language');

    setLocale('zh');
    expect(getLocale()).toBe(t());
    expect(getLocale().settings.appearance.language).toBe('语言');
  });

  it('keeps all release-critical i18n surfaces addressable', () => {
    setLocale('zh');
    expect(t().settings.reconnect.failed).toBeTruthy();
    expect(t().usage.thinking).toBeTruthy();
    expect(t().sync.ruleFailed).toContain('{rule}');
    expect(t().sync.ruleFailed).toContain('{error}');
    expect(t().inlineEdit.prompt).toContain('{text}');
    expect(t().acp.stdinNotWritable).toBeTruthy();
    expect(t().session.defaultTitle).toContain('{time}');
    expect(t().settings.diagnostics.runtimeDetail).toContain('{modes}');
    expect(t().settings.diagnostics.runtimeDetail).toContain('{models}');
    expect(t().settings.diagnostics.runtimeDetail).toContain('{commands}');
    expect(t().settings.diagnostics.mcpDetail).toContain('{enabled}');
    expect(t().settings.diagnostics.mcpDetail).toContain('{configured}');
  });
});

describe('lookupLocaleString', () => {
  it('resolves dotted paths against the active locale', () => {
    setLocale('en');
    expect(lookupLocaleString('copy.button')).toBe('Copy');
    expect(lookupLocaleString('toolKind.switch_mode')).toBe('Switch Mode');
    setLocale('zh');
    expect(lookupLocaleString('copy.button')).toBe('复制');
    expect(lookupLocaleString('toolKind.switch_mode')).toBe('切换模式');
    setLocale('en');
  });

  it('returns undefined for missing paths and non-string leaves', () => {
    setLocale('en');
    expect(lookupLocaleString('nope.nothing')).toBeUndefined();
    expect(lookupLocaleString('copy.button.extra')).toBeUndefined();
    expect(lookupLocaleString('appName.extra')).toBeUndefined();
    // A namespace is an object, not a label.
    expect(lookupLocaleString('toolbar.effort')).toBeUndefined();
  });
});
