import type { App } from 'obsidian';
import { MarkdownRenderer } from 'obsidian';

export class ChatRenderer {
  private container: HTMLDivElement;
  private currentAssistantEl: HTMLDivElement | null = null;
  private currentAssistantText = '';
  private thinkingEl: HTMLDivElement | null = null;
  private thinkingCollapsed = true;
  private planEl: HTMLDivElement | null = null;
  private toolEls = new Map<string, HTMLDivElement>();
  private placeholderEl: HTMLDivElement | null = null;
  private renderTimeout: number | null = null;

  constructor(container: HTMLDivElement, _app: App) {
    this.container = container;
  }

  clear(): void {
    this.container.empty();
    this.toolEls.clear();
    this.currentAssistantEl = null;
    this.currentAssistantText = '';
    this.thinkingEl = null;
    this.planEl = null;
    this.placeholderEl = null;
    if (this.renderTimeout !== null) {
      clearTimeout(this.renderTimeout);
      this.renderTimeout = null;
    }
  }

  private scrollToBottom(): void {
    requestAnimationFrame(() => {
      this.container.scrollTop = this.container.scrollHeight;
    });
  }

  addUserMessage(text: string): void {
    const wrap = this.container.createDiv({ cls: 'copsidian-msg user' });
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

  appendText(text: string): void {
    this.currentAssistantText += text;
    if (!this.currentAssistantEl) {
      const wrap = this.container.createDiv({ cls: 'copsidian-msg assistant' });
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

    MarkdownRenderer.renderMarkdown(
      this.currentAssistantText,
      placeholder,
      '',
      { on: () => {}, off: () => {}, root: new HTMLElement() } as any,
    ).catch(() => {
      this.currentAssistantEl!.textContent = this.currentAssistantText;
    });
  }

  appendThinking(text: string): void {
    if (!this.thinkingEl) {
      const wrap = this.container.createDiv({ cls: 'copsidian-msg assistant' });
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
    content?: Array<{ type: string; content: { type: string; text?: string } }>,
  ): void {
    const box = this.toolEls.get(id);
    if (!box) return;
    const hdr = box.querySelector('.copsidian-tool-call-header') as HTMLElement;
    const statusEl = hdr.querySelector('.tc-status') as HTMLElement;
    statusEl.textContent = status;

    if (status === 'completed' && content?.[0]?.content?.text) {
      const body = box.querySelector('.copsidian-tool-call-body') as HTMLElement;
      body.textContent = content[0].content.text;
      body.style.display = 'block';
    } else if (status === 'in_progress') {
      statusEl.textContent = 'running…';
    }
    box.style.display = 'block';
    this.scrollToBottom();
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
