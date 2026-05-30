import type { App, Component } from 'obsidian';
import { MarkdownRenderer } from 'obsidian';
import { ContextInjection } from '../context/injection';
import { t, onLocaleChange } from '../i18n/index';

export interface UsageDisplay {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens?: number;
  cost?: { amount: number; currency: string };
  modelId?: string;
  elapsedMs?: number;
}

export class ChatRenderer {
  private container: HTMLDivElement;
  private app: App;
  private shouldAutoScroll: () => boolean;
  private currentAssistantEl: HTMLDivElement | null = null;
  private currentAssistantWrap: HTMLDivElement | null = null;
  private currentAssistantText = '';
  private currentAssistantId: string | null = null;
  private currentAssistantType: 'text' | 'thinking' = 'text';
  private thinkingEl: HTMLDivElement | null = null;
  private thinkingCollapsed = true;
  private planEl: HTMLDivElement | null = null;
  private toolEls = new Map<string, HTMLDivElement>();
  private placeholderEl: HTMLDivElement | null = null;
  private renderTimeout: number | null = null;
  private usageEls = new Map<HTMLDivElement, UsageDisplay>();

  constructor(container: HTMLDivElement, app: App, shouldAutoScroll: () => boolean = () => true) {
    this.container = container;
    this.app = app;
    this.shouldAutoScroll = shouldAutoScroll;
    onLocaleChange(() => this.refreshLocale());
  }

  clear(): void {
    this.container.empty();
    this.toolEls.clear();
    this.currentAssistantEl = null;
    this.currentAssistantWrap = null;
    this.currentAssistantText = '';
    this.currentAssistantId = null;
    this.currentAssistantType = 'text';
    this.thinkingEl = null;
    this.planEl = null;
    this.placeholderEl = null;
    this.usageEls.clear();
    if (this.renderTimeout !== null) {
      clearTimeout(this.renderTimeout);
      this.renderTimeout = null;
    }
  }

  private scrollToBottom(): void {
    if (!this.shouldAutoScroll()) return;
    requestAnimationFrame(() => {
      this.container.scrollTop = this.container.scrollHeight;
    });
  }

  forceScrollToBottom(): void {
    requestAnimationFrame(() => {
      this.container.scrollTop = this.container.scrollHeight;
    });
  }

  addUserMessage(text: string, timestamp?: number): void {
    const wrap = this.container.createDiv({ cls: 'copsilot-msg user' });
    wrap.dataset.timestamp = this.formatTimestamp(timestamp ?? Date.now());
    const body = wrap.createDiv({ cls: 'copsilot-msg-body' });
    body.textContent = text;
    this.scrollToBottom();
  }

  addAssistantPlaceholder(): void {
    if (this.placeholderEl) return;
    const wrap = this.container.createDiv({ cls: 'copsilot-msg assistant' });
    const el = wrap.createDiv({ cls: 'copsilot-loading' });
    el.createDiv({ cls: 'copsilot-spinner' });
    el.createSpan({ text: t().loading.thinking });
    this.placeholderEl = wrap;
    this.scrollToBottom();
  }

  removeAssistantPlaceholder(): void {
    this.placeholderEl?.remove();
    this.placeholderEl = null;
  }

  appendText(text: string, messageId?: string, timestamp?: number): void {
    if (messageId && this.currentAssistantId !== messageId) {
      this.currentAssistantEl = null;
      this.currentAssistantWrap = null;
      this.currentAssistantText = '';
      this.currentAssistantId = messageId;
      this.currentAssistantType = 'text';
    }
    if (this.currentAssistantType !== 'text') {
      this.currentAssistantEl = null;
      this.currentAssistantWrap = null;
      this.currentAssistantText = '';
      this.currentAssistantType = 'text';
    }
    this.currentAssistantText += text;
    if (!this.currentAssistantEl) {
      const wrap = this.container.createDiv({ cls: 'copsilot-msg assistant' });
      wrap.dataset.timestamp = this.formatTimestamp(timestamp ?? Date.now());
      this.currentAssistantWrap = wrap;
      this.currentAssistantEl = wrap.createDiv({ cls: 'copsilot-msg-body' });
    }
    if (this.renderTimeout !== null) clearTimeout(this.renderTimeout);
    this.renderTimeout = window.setTimeout(() => {
      this.renderMarkdown();
      this.renderTimeout = null;
    }, 50);
    this.scrollToBottom();
  }

  private renderMarkdown(): void {
    if (!this.currentAssistantEl || !this.currentAssistantText) return;

    const existing = this.currentAssistantEl.querySelector('.md-render-subsystem');
    if (existing) existing.remove();

    const placeholder = document.createElement('div');
    placeholder.addClass('md-render-subsystem');
    this.currentAssistantEl.appendChild(placeholder);

    // Inject wikilinks for vault file paths
    const textWithWikilinks = ContextInjection.injectWikilinks(
      this.currentAssistantText,
      this.app.vault
    );

    MarkdownRenderer.renderMarkdown(
      textWithWikilinks,
      placeholder,
      '',
      this.container as unknown as Component,
    ).then(() => {
      this.addCopyButtons(placeholder);
    }).catch(() => {
      this.currentAssistantEl!.textContent = this.currentAssistantText;
    });
  }

  private addCopyButtons(container: HTMLElement): void {
    const codeBlocks = container.querySelectorAll('pre > code');
    codeBlocks.forEach((codeEl) => {
      const pre = codeEl.parentElement;
      if (!pre || pre.querySelector('.copsilot-copy-btn')) return;

      const btn = document.createElement('button');
      btn.className = 'copsilot-copy-btn';
      btn.textContent = t().copy.button;
      btn.onclick = async () => {
        const text = codeEl.textContent || '';
        await navigator.clipboard.writeText(text);
        btn.textContent = t().copy.copied;
        setTimeout(() => { btn.textContent = t().copy.button; }, 1500);
      };
      pre.style.position = 'relative';
      pre.appendChild(btn);
    });
  }

  appendThinking(text: string, messageId?: string, timestamp?: number): void {
    if (messageId && this.currentAssistantId !== messageId) {
      this.thinkingEl = null;
      this.currentAssistantId = messageId;
      this.currentAssistantType = 'thinking';
      this.currentAssistantText = '';
    }
    if (this.currentAssistantType !== 'thinking') {
      this.thinkingEl = null;
      this.currentAssistantType = 'thinking';
    }
    if (!this.thinkingEl) {
      const wrap = this.container.createDiv({ cls: 'copsilot-msg assistant' });
      wrap.dataset.timestamp = this.formatTimestamp(timestamp ?? Date.now());
      const box = wrap.createDiv({ cls: 'copsilot-thinking' });
      const hdr = box.createDiv({ cls: 'copsilot-thinking-header', text: t().thinking.header });
      this.thinkingEl = box.createDiv({ cls: 'copsilot-thinking-body' });
      this.thinkingEl.style.display = 'none';
      hdr.onclick = () => {
        this.thinkingCollapsed = !this.thinkingCollapsed;
        this.thinkingEl!.style.display = this.thinkingCollapsed ? 'none' : 'block';
      };
    }
    this.thinkingEl.appendChild(document.createTextNode(text));
    this.scrollToBottom();
  }

  addToolCall(id: string, title: string, kind: string, input: Record<string, unknown> | undefined): void {
    const wrap = this.container.createDiv({ cls: 'copsilot-msg assistant' });
    const box = wrap.createDiv({ cls: 'copsilot-tool-call' });
    box.dataset.toolId = id;

    const hdr = box.createDiv({ cls: 'copsilot-tool-call-header' });
    hdr.createSpan({ text: kind || 'tool', cls: 'tc-kind' });

    const filePath = (input?.filePath ?? input?.path ?? title) as string;
    const fileName = filePath.split('/').pop() ?? filePath;
    hdr.createSpan({ text: fileName, cls: 'tc-file' });

    hdr.createSpan({ text: '…', cls: 'tc-stat' });

    const body = box.createDiv({ cls: 'copsilot-tool-call-body' });
    body.style.display = 'none';

    hdr.onclick = () => { body.style.display = body.style.display === 'none' ? 'block' : 'none'; };

    this.toolEls.set(id, box);
  }

  updateToolCall(
    id: string,
    status: string,
    _rawOutput?: Record<string, unknown>,
    content?: Array<{ type: string; content?: { type: string; text?: string }; path?: string; oldText?: string; newText?: string }>,
  ): void {
    const box = this.toolEls.get(id);
    if (!box) return;
    const hdr = box.querySelector('.copsilot-tool-call-header') as HTMLElement;
    const statEl = hdr.querySelector('.tc-stat') as HTMLElement;

    const body = box.querySelector('.copsilot-tool-call-body') as HTMLElement;

    if (status === 'completed' && content) {
      body.empty();
      let added = 0, removed = 0;
      for (const item of content) {
        if (item.type === 'diff' && item.path && item.oldText !== undefined && item.newText !== undefined) {
          const oldLines = item.oldText.split('\n');
          const newLines = item.newText.split('\n');
          for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
            if (oldLines[i] === undefined) added++;
            else if (newLines[i] === undefined) removed++;
            else if (oldLines[i] !== newLines[i]) { added++; removed++; }
          }
          body.appendChild(this.renderDiff(item.path, item.oldText, item.newText));
        } else if (item.type === 'content' && item.content?.text) {
          body.createDiv({ text: item.content.text });
        }
      }
      const statParts: string[] = [];
      if (added) statParts.push(`+${added}`);
      if (removed) statParts.push(`-${removed}`);
      statEl.textContent = statParts.join(' ') || '✓';
      statEl.className = 'tc-stat tc-stat-done';
    } else if (status === 'in_progress') {
      statEl.textContent = '…';
    } else if (status === 'failed') {
      statEl.textContent = '✗';
      statEl.className = 'tc-stat tc-stat-fail';
    }
    this.scrollToBottom();
  }

  private renderDiff(path: string, oldText: string, newText: string): HTMLElement {
    const container = document.createElement('div');
    container.className = 'copsilot-diff';

    const header = container.createDiv({ cls: 'copsilot-diff-header', text: path });

    const body = container.createDiv({ cls: 'copsilot-diff-body' });

    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');

    // Simple line-by-line diff
    const maxLen = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < maxLen; i++) {
      const oldLine = oldLines[i];
      const newLine = newLines[i];

      if (oldLine === undefined) {
        // Added line
        const line = body.createDiv({ cls: 'diff-line added' });
        line.createSpan({ cls: 'diff-marker', text: '+' });
        line.createSpan({ text: newLine });
      } else if (newLine === undefined) {
        // Removed line
        const line = body.createDiv({ cls: 'diff-line removed' });
        line.createSpan({ cls: 'diff-marker', text: '-' });
        line.createSpan({ text: oldLine });
      } else if (oldLine !== newLine) {
        // Changed line - show removal then addition
        const rmLine = body.createDiv({ cls: 'diff-line removed' });
        rmLine.createSpan({ cls: 'diff-marker', text: '-' });
        rmLine.createSpan({ text: oldLine });
        const addLine = body.createDiv({ cls: 'diff-line added' });
        addLine.createSpan({ cls: 'diff-marker', text: '+' });
        addLine.createSpan({ text: newLine });
      } else {
        // Context line
        const line = body.createDiv({ cls: 'diff-line context' });
        line.createSpan({ cls: 'diff-marker', text: ' ' });
        line.createSpan({ text: oldLine });
      }
    }

    header.onclick = () => {
      body.style.display = body.style.display === 'none' ? 'block' : 'none';
    };

    return container;
  }

  setPlanEntries(entries: Array<{ content: string; status: string; priority?: string }>): void {
    if (!this.planEl) {
      this.planEl = this.container.createDiv({ cls: 'copsilot-plan-panel' });
      this.planEl.createDiv({ cls: 'plan-title', text: t().plan.title });
    }
    this.planEl.querySelectorAll('.plan-item').forEach((el) => el.remove());
    for (const e of entries) {
      const icon = e.status === 'completed' ? '✓' : e.status === 'in_progress' ? '⟳' : '○';
      this.planEl.createDiv({ cls: `plan-item status-${e.status}`, text: `${icon} ${e.content}` });
    }
    this.scrollToBottom();
  }

  addError(text: string, actionLabel?: string, actionCallback?: () => void | Promise<void>): void {
    this.removeAssistantPlaceholder();
    const wrap = this.container.createDiv({ cls: 'copsilot-msg assistant' });
    const errorEl = wrap.createDiv({ cls: 'copsilot-error' });
    errorEl.createSpan({ cls: 'copsilot-error-text', text });

    if (actionLabel && actionCallback) {
      const btn = errorEl.createEl('button', {
        cls: 'copsilot-error-action',
        text: actionLabel,
      });
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = '...';
        try {
          await actionCallback();
        } finally {
          btn.disabled = false;
          btn.textContent = actionLabel;
        }
      };
    }

    this.scrollToBottom();
  }

  showUsage(usage: UsageDisplay): void {
    // Ensure we have a wrap to attach usage to (may be null if only tool calls, no text)
    if (!this.currentAssistantWrap) {
      const wrap = this.container.createDiv({ cls: 'copsilot-msg assistant' });
      this.currentAssistantWrap = wrap;
    }
    const target = this.currentAssistantWrap;

    target.querySelector('.copsilot-usage')?.remove();
    const el = target.createDiv({ cls: 'copsilot-usage' });

    const parts: string[] = [];
    if (usage.modelId) parts.push(usage.modelId.split('/').pop() ?? usage.modelId);
    if (usage.elapsedMs !== undefined) parts.push(`${(usage.elapsedMs / 1000).toFixed(1)}s`);
    if (usage.inputTokens) parts.push(`↑${usage.inputTokens}`);
    if (usage.outputTokens) parts.push(`↓${usage.outputTokens}`);
    if (usage.thoughtTokens) parts.push(`💭${usage.thoughtTokens}`);
    if (usage.cost?.amount) parts.push(`$${usage.cost.amount.toFixed(4)}`);
    el.textContent = parts.join(' · ');
    this.usageEls.set(el, usage);
    el.title = this.formatUsageTitle(usage);

    this.scrollToBottom();
  }

  refreshLocale(): void {
    for (const [el, usage] of this.usageEls) {
      if (!el.isConnected) {
        this.usageEls.delete(el);
        continue;
      }
      el.title = this.formatUsageTitle(usage);
    }
  }

  private formatUsageTitle(usage: UsageDisplay): string {
    const labels = t().usage;
    return `${labels.model}: ${usage.modelId ?? '?'} | ${labels.input}: ${usage.inputTokens}, ${labels.output}: ${usage.outputTokens}${usage.thoughtTokens ? `, ${labels.thinking}: ${usage.thoughtTokens}` : ''}`;
  }

  private formatTimestamp(ts: number): string {
    const date = new Date(ts);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}
