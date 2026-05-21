import { describe, expect, it } from 'vitest';
import { setLocale, t } from './index';

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

  it('keeps all release-critical i18n surfaces addressable', () => {
    setLocale('zh');
    expect(t().settings.reconnect.failed).toBeTruthy();
    expect(t().usage.thinking).toBeTruthy();
    expect(t().sync.ruleFailed).toContain('{rule}');
    expect(t().sync.ruleFailed).toContain('{error}');
    expect(t().inlineEdit.prompt).toContain('{text}');
    expect(t().acp.stdinNotWritable).toBeTruthy();
    expect(t().acp.requestTimeout).toBeTruthy();
    expect(t().session.defaultTitle).toContain('{time}');
  });
});
