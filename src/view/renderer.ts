import type { App } from 'obsidian';
import { MarkdownRenderer } from 'obsidian';
import { ContextInjection } from '../context/injection';

export interface UsageDisplay {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens?: number;
  cost?: { amount: number; currency: string };
  modelId?: string;
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

  constructor(container: HTMLDivElement, app: App, shouldAutoScroll: () => boolean = () => true) {
    this.container = container;
    this.app = app;
    this.shouldAutoScroll = shouldAutoScroll;
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
    const wrap = this.container.createDiv({ cls: 'copsidian-msg user' });
    wrap.dataset.timestamp = this.formatTimestamp(timestamp ?? Date.now());
    const body = wrap.createDiv({ cls: 'copsidian-msg-body' });
    body.textContent = text;
    this.scrollToBottom();
  }

  addAssistantPlaceholder(): void {
    if (this.placeholderEl) return;
    const wrap = this.container.createDiv({ cls: 'copsidian-msg assistant' });
    const el = wrap.createDiv({ cls: 'copsidian-loading' });
    el.createDiv({ cls: 'copsidian-spinner' });
    el.createSpan({ text: 'Thinking…' });
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
      const wrap = this.container.createDiv({ cls: 'copsidian-msg assistant' });
      wrap.dataset.timestamp = this.formatTimestamp(timestamp ?? Date.now());
      this.currentAssistantWrap = wrap;
      this.currentAssistantEl = wrap.createDiv({ cls: 'copsidian-msg-body' });
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
      this.container as any,
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
      if (!pre || pre.querySelector('.copsidian-copy-btn')) return;

      const btn = document.createElement('button');
      btn.className = 'copsidian-copy-btn';
      btn.textContent = 'Copy';
      btn.onclick = async () => {
        const text = codeEl.textContent || '';
        await navigator.clipboard.writeText(text);
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
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
      const wrap = this.container.createDiv({ cls: 'copsidian-msg assistant' });
      wrap.dataset.timestamp = this.formatTimestamp(timestamp ?? Date.now());
      const box = wrap.createDiv({ cls: 'copsidian-thinking' });
      const hdr = box.createDiv({ cls: 'copsidian-thinking-header', text: 'Thinking' });
      this.thinkingEl = box.createDiv({ cls: 'copsidian-thinking-body' });
      this.thinkingEl.style.display = 'none';
      hdr.onclick = () => {
        this.thinkingCollapsed = !this.thinkingCollapsed;
        this.thinkingEl!.style.display = this.thinkingCollapsed ? 'none' : 'block';
      };
    }
    this.thinkingEl.appendChild(document.createTextNode(text));
    this.scrollToBottom();
  }

  addToolCall(id: string, title: string, kind: string, input: Record<string, unknown>): void {
    const wrap = this.container.createDiv({ cls: 'copsidian-msg assistant' });
    const box = wrap.createDiv({ cls: 'copsidian-tool-call' });
    box.dataset.toolId = id;

    const toolIcon = this.toolIcon(kind);
    const hdr = box.createDiv({ cls: 'copsidian-tool-call-header' });
    hdr.createSpan({ text: `${toolIcon} ${title}`, cls: 'tc-title' });
    hdr.createSpan({ text: 'pending', cls: 'tc-status' });

    const body = box.createDiv({ cls: 'copsidian-tool-call-body' });
    body.textContent = JSON.stringify(input, null, 2);
    body.style.display = 'none';

    box.style.display = 'none';
    hdr.onclick = () => { box.style.display = box.style.display === 'none' ? 'block' : 'none' };

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
    const hdr = box.querySelector('.copsidian-tool-call-header') as HTMLElement;
    const statusEl = hdr.querySelector('.tc-status') as HTMLElement;
    statusEl.textContent = status;

    const body = box.querySelector('.copsidian-tool-call-body') as HTMLElement;

    if (status === 'completed' && content) {
      body.empty();
      for (const item of content) {
        if (item.type === 'diff' && item.path && item.oldText !== undefined && item.newText !== undefined) {
          const diffEl = this.renderDiff(item.path, item.oldText, item.newText);
          body.appendChild(diffEl);
        } else if (item.type === 'content' && item.content?.text) {
          body.createDiv({ text: item.content.text });
        }
      }
      body.style.display = 'block';
    } else if (status === 'in_progress') {
      statusEl.textContent = 'running…';
    }
    box.style.display = 'block';
    this.scrollToBottom();
  }

  private renderDiff(path: string, oldText: string, newText: string): HTMLElement {
    const container = document.createElement('div');
    container.className = 'copsidian-diff';

    const header = container.createDiv({ cls: 'copsidian-diff-header', text: path });

    const body = container.createDiv({ cls: 'copsidian-diff-body' });

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
      this.planEl = this.container.createDiv({ cls: 'copsidian-plan-panel' });
      this.planEl.createDiv({ cls: 'plan-title', text: '📋 Plan' });
    }
    this.planEl.querySelectorAll('.plan-item').forEach((el) => el.remove());
    for (const e of entries) {
      const icon = e.status === 'completed' ? '✓' : e.status === 'in_progress' ? '⟳' : '○';
      this.planEl.createDiv({ cls: `plan-item status-${e.status}`, text: `${icon} ${e.content}` });
    }
    this.scrollToBottom();
  }

  addError(text: string): void {
    this.removeAssistantPlaceholder();
    const wrap = this.container.createDiv({ cls: 'copsidian-msg assistant' });
    wrap.createDiv({ cls: 'copsidian-error', text });
    this.scrollToBottom();
  }

  showUsage(usage: UsageDisplay): void {
    const target = this.currentAssistantWrap;
    if (!target) return;

    target.querySelector('.copsidian-usage')?.remove();
    const el = target.createDiv({ cls: 'copsidian-usage' });

    const parts: string[] = [];
    if (usage.modelId) parts.push(usage.modelId.split('/').pop() ?? usage.modelId);
    if (usage.inputTokens) parts.push(`↑${usage.inputTokens}`);
    if (usage.outputTokens) parts.push(`↓${usage.outputTokens}`);
    if (usage.thoughtTokens) parts.push(`💭${usage.thoughtTokens}`);
    if (usage.cost?.amount) parts.push(`$${usage.cost.amount.toFixed(4)}`);
    el.textContent = parts.join(' · ');
    el.title = `Model: ${usage.modelId ?? '?'} | Input: ${usage.inputTokens}, Output: ${usage.outputTokens}${usage.thoughtTokens ? `, Thinking: ${usage.thoughtTokens}` : ''}`;

    this.scrollToBottom();
  }

  private formatTimestamp(ts: number): string {
    const date = new Date(ts);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  private toolIcon(kind: string): string {
    switch (kind) {
      case 'read': return '[read]';
      case 'edit': return '[edit]';
      case 'execute': return '[exec]';
      case 'fetch': return '[fetch]';
      case 'search': return '[search]';
      default: return '[tool]';
    }
  }
}
