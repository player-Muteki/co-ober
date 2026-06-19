import type { App } from 'obsidian';
import { MarkdownRenderer, type Component } from 'obsidian';
import { t, onLocaleChange } from '../i18n/index';
import type { UsageInfo, ContentBlock, SerializedMessage } from '../types';
import {
  renderLiveThinkingBlock,
  renderStoredThinkingBlock,
  finalizeThinkingBlock,
  appendThinkingContent,
  cleanupThinkingBlock,
  type ThinkingState,
} from './thinkingBlockRenderer';
import {
  createToolCallElement,
  updateToolCallElement,
  type ToolCallState,
} from './ToolCallRenderer';

export class ChatRenderer {
  private container: HTMLDivElement;
  private app: App;
  private doc: Document;
  private shouldAutoScroll: () => boolean;

  // ---- Streaming message state ----
  private currentAssistantEl: HTMLDivElement | null = null;
  private currentAssistantWrap: HTMLDivElement | null = null;
  private currentAssistantText = '';
  private currentAssistantId: string | null = null;
  private currentAssistantType: 'text' | 'thinking' = 'text';
  private liveThinkingState: ThinkingState | null = null;
  private planEl: HTMLDivElement | null = null;
  private placeholderEl: HTMLDivElement | null = null;
  private usageEls = new Map<HTMLDivElement, UsageInfo>();
  private unsubscribeLocale: () => void;

  // ---- Three-layer render frame scheduling ----
  // Layer 1: Text render pipeline (requestAnimationFrame + Promise)
  private textRenderFrame: number | null = null;
  private textRenderPromise: Promise<void> | null = null;
  private resolveTextRender: (() => void) | null = null;
  private isTextRenderRunning = false;

  // Layer 3: Tool output per-frame scheduling
  private toolRenderFrames = new Map<string, number>();

  // Legacy fallback (pre-existing elements without ToolCallState)
  private toolEls = new Map<string, HTMLDivElement>();

  // Structured tool call states (new approach)
  private toolCallStates = new Map<string, ToolCallState>();

  constructor(container: HTMLDivElement, app: App, shouldAutoScroll: () => boolean = () => true) {
    this.container = container;
    this.app = app;
    this.doc = container.ownerDocument ?? activeDocument;
    this.shouldAutoScroll = shouldAutoScroll;
    this.unsubscribeLocale = onLocaleChange(() => this.refreshLocale());
  }

  dispose(): void {
    this.cancelTextRender();
    this.cancelThinkingRender();
    this.cancelAllToolRenders();
    this.unsubscribeLocale();
  }

  clear(): void {
    this.cancelTextRender();
    this.cancelThinkingRender();
    this.cancelAllToolRenders();

    this.container.empty();
    this.toolEls.clear();
    this.toolCallStates.clear();
    this.currentAssistantEl = null;
    this.currentAssistantWrap = null;
    this.currentAssistantText = '';
    this.currentAssistantId = null;
    this.currentAssistantType = 'text';
    this.liveThinkingState = null;
    this.planEl = null;
    this.placeholderEl = null;
    this.usageEls.clear();
  }

  private scrollToBottom(): void {
    if (!this.shouldAutoScroll()) return;
    window.requestAnimationFrame(() => {
      this.container.scrollTop = this.container.scrollHeight;
    });
  }

  forceScrollToBottom(): void {
    window.requestAnimationFrame(() => {
      this.container.scrollTop = this.container.scrollHeight;
    });
  }

  addSystemMessage(text: string): void {
    const wrap = this.container.createDiv({ cls: 'co-ober-msg system' });
    const body = wrap.createDiv({ cls: 'co-ober-msg-body' });
    MarkdownRenderer.renderMarkdown(text, body, '', this.app as unknown as Component);
    this.scrollToBottom();
  }

  addUserMessage(text: string, timestamp?: number): void {
    const wrap = this.container.createDiv({ cls: 'co-ober-msg user' });
    wrap.dataset.timestamp = this.formatTimestamp(timestamp ?? Date.now());
    const body = wrap.createDiv({ cls: 'co-ober-msg-body' });
    body.textContent = text;
    this.scrollToBottom();
  }

  addAssistantPlaceholder(): void {
    if (this.placeholderEl) return;
    const wrap = this.container.createDiv({ cls: 'co-ober-msg assistant' });
    const el = wrap.createDiv({ cls: 'co-ober-loading' });
    el.createDiv({ cls: 'co-ober-spinner' });
    el.createSpan({ text: t().loading.thinking });
    this.placeholderEl = wrap;
    this.scrollToBottom();
  }

  removeAssistantPlaceholder(): void {
    this.placeholderEl?.remove();
    this.placeholderEl = null;
  }

  // ============================================
  // Layer 1: Text Render Pipeline
  // ============================================

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
      const wrap = this.container.createDiv({ cls: 'co-ober-msg assistant' });
      wrap.dataset.timestamp = this.formatTimestamp(timestamp ?? Date.now());
      this.currentAssistantWrap = wrap;
      this.currentAssistantEl = wrap.createDiv({ cls: 'co-ober-msg-body' });
    }
    this.scheduleTextRender();
    this.scrollToBottom();
  }

  /**
   * Schedule text markdown render via requestAnimationFrame.
   * Returns a promise that resolves when the render completes.
   */
  scheduleTextRender(): Promise<void> {
    if (!this.textRenderPromise) {
      this.textRenderPromise = new Promise(resolve => {
        this.resolveTextRender = resolve;
      });
    }

    if (this.textRenderFrame === null && !this.isTextRenderRunning) {
      this.textRenderFrame = window.requestAnimationFrame(() => {
        this.textRenderFrame = null;
        void this.executeTextRender();
      });
    }

    return this.textRenderPromise;
  }

  /**
   * Flush pending text render immediately (cancel schedule + execute now).
   * Used by StreamController when content type changes (e.g., text→thinking).
   */
  async flushTextRender(): Promise<void> {
    if (this.textRenderFrame !== null) {
      window.cancelAnimationFrame(this.textRenderFrame);
      this.textRenderFrame = null;
      void this.executeTextRender();
    }

    if (this.textRenderPromise) {
      await this.textRenderPromise;
    }
  }

  private async executeTextRender(): Promise<void> {
    if (this.isTextRenderRunning) return;
    this.isTextRenderRunning = true;

    try {
      if (this.currentAssistantEl && this.currentAssistantText) {
        const existing = this.currentAssistantEl.querySelector('.md-render-subsystem');
        if (existing) existing.remove();

        const placeholder = this.doc.createElement('div');
        placeholder.addClass('md-render-subsystem');
        this.currentAssistantEl.appendChild(placeholder);

        await MarkdownRenderer.render(
          this.app,
          this.currentAssistantText,
          placeholder,
          this.app.vault.getRoot().path,
          this.container as unknown as Component,
        );

        this.addCopyButtons(placeholder);
      }
    } catch {
      if (this.currentAssistantEl && this.currentAssistantText) {
        this.currentAssistantEl.textContent = this.currentAssistantText;
      }
    } finally {
      this.isTextRenderRunning = false;
    }

    // If more text arrived during render, schedule another pass
    if (this.currentAssistantEl && this.resolveTextRender) {
      const resolve = this.resolveTextRender;
      this.textRenderPromise = null;
      this.resolveTextRender = null;
      resolve();
    }
  }

  cancelTextRender(): void {
    if (this.textRenderFrame !== null) {
      window.cancelAnimationFrame(this.textRenderFrame);
      this.textRenderFrame = null;
    }

    if (this.resolveTextRender) {
      const resolve = this.resolveTextRender;
      this.textRenderPromise = null;
      this.resolveTextRender = null;
      resolve();
    }
  }

  private addCopyButtons(container: HTMLElement): void {
    const codeBlocks = container.querySelectorAll('pre > code');
    codeBlocks.forEach((codeEl) => {
      const pre = codeEl.parentElement;
      if (!pre || pre.querySelector('.co-ober-copy-btn')) return;

      const btn = this.doc.createElement('button');
      btn.className = 'co-ober-copy-btn';
      btn.textContent = t().copy.button;
      btn.onclick = () => {
        const text = codeEl.textContent || '';
        void navigator.clipboard.writeText(text);
        btn.textContent = t().copy.copied;
        window.setTimeout(() => { btn.textContent = t().copy.button; }, 1500);
      };
      pre.classList.add('co-ober-code-block');
      pre.appendChild(btn);
    });
  }

  // ============================================
  // Layer 2: Thinking Render Pipeline
  // ============================================

  // ============================================
  // Thinking block — uses thinkingBlockRenderer for structured rendering
  // ============================================

  /**
   * Append streaming thought text.
   * On first call, creates the structured thinking block via renderLiveThinkingBlock().
   */
  appendThinking(text: string, messageId?: string, timestamp?: number): void {
    // Reset on message ID change or type switch
    if (messageId && this.currentAssistantId !== messageId) {
      this.finalizeCurrentThinking();
      this.currentAssistantId = messageId;
      this.currentAssistantType = 'thinking';
    }
    if (this.currentAssistantType !== 'thinking') {
      this.finalizeCurrentThinking();
      this.currentAssistantType = 'thinking';
    }

    // Create structured thinking block on first append
    if (!this.liveThinkingState) {
      const wrap = this.container.createDiv({ cls: 'co-ober-msg assistant' });
      wrap.dataset.timestamp = this.formatTimestamp(timestamp ?? Date.now());
      this.liveThinkingState = renderLiveThinkingBlock(wrap);
    }

    appendThinkingContent(this.liveThinkingState, text);
    this.scrollToBottom();
  }

  /**
   * Finalize the current live thinking block (auto-collapse, update label).
   * Returns the duration in seconds, or 0 if no thinking block was active.
   */
  finalizeCurrentThinking(): number {
    if (!this.liveThinkingState) return 0;
    const elapsed = finalizeThinkingBlock(this.liveThinkingState);
    this.liveThinkingState = null;
    return elapsed;
  }

  /**
   * Schedule thinking markdown render via requestAnimationFrame.
   * (Kept for backward compat — thinkingBlockRenderer handles its own rendering)
   */
  scheduleThinkingRender(): Promise<void> {
    return Promise.resolve();
  }

  async flushThinkingRender(): Promise<void> {
    // No-op: thinkingBlockRenderer updates inline, no MarkdownRenderer needed
  }

  cancelThinkingRender(): void {
    if (this.liveThinkingState) {
      cleanupThinkingBlock(this.liveThinkingState);
      this.liveThinkingState = null;
    }
  }

  addToolCall(id: string, title: string, kind: string, input: Record<string, unknown> | undefined, locations?: { path: string }[]): void {
    const wrap = this.container.createDiv({ cls: 'co-ober-msg assistant' });
    const toolState = createToolCallElement(wrap, id, kind, title, input, locations);
    this.toolCallStates.set(id, toolState);
  }

  // ============================================
  // Layer 3: Tool Output Scheduling
  // ============================================

  // Pending tool render callbacks for synchronous flush support
  private pendingToolRenderCallbacks = new Map<string, () => void>();

  /**
   * Schedule a tool call update to be rendered on the next animation frame.
   * Each tool has its own frame, so fast updates don't block each other.
   */
  scheduleToolRender(id: string, callback: () => void): void {
    // Cancel any pending frame for this tool
    const existing = this.toolRenderFrames.get(id);
    if (existing !== undefined) {
      window.cancelAnimationFrame(existing);
    }

    // Store callback for synchronous flush
    this.pendingToolRenderCallbacks.set(id, callback);

    const frame = window.requestAnimationFrame(() => {
      this.toolRenderFrames.delete(id);
      this.pendingToolRenderCallbacks.delete(id);
      callback();
    });
    this.toolRenderFrames.set(id, frame);
  }

  cancelToolRender(id: string): void {
    const frame = this.toolRenderFrames.get(id);
    if (frame !== undefined) {
      window.cancelAnimationFrame(frame);
      this.toolRenderFrames.delete(id);
    }
    this.pendingToolRenderCallbacks.delete(id);
  }

  /**
   * Flush all pending tool renders synchronously (execute callbacks immediately).
   * Used in tests and when content type changes mid-stream.
   */
  flushAllToolRenders(): void {
    // Cancel all pending frames
    for (const [id, frame] of this.toolRenderFrames) {
      window.cancelAnimationFrame(frame);
      const callback = this.pendingToolRenderCallbacks.get(id);
      if (callback) {
        callback();
      }
    }
    this.toolRenderFrames.clear();
    this.pendingToolRenderCallbacks.clear();
  }

  cancelAllToolRenders(): void {
    for (const frame of this.toolRenderFrames.values()) {
      window.cancelAnimationFrame(frame);
    }
    this.toolRenderFrames.clear();
    this.pendingToolRenderCallbacks.clear();
  }

  updateToolCall(
    id: string,
    status: string,
    rawOutput?: Record<string, unknown>,
    content?: Array<{ type: string; content?: { type: string; text?: string }; path?: string; oldText?: string; newText?: string }>,
    rawInput?: Record<string, unknown>,
    locations?: { path: string }[],
    kind?: string,
  ): void {
    // Use stored ToolCallState from createToolCallElement (with frame scheduling)
    const toolState = this.toolCallStates.get(id);
    if (toolState) {
      this.scheduleToolRender(id, () => {
        updateToolCallElement(
          toolState, status, kind ?? toolState.kindEl.textContent?.toLowerCase() ?? '',
          rawOutput, content as any, rawInput, locations,
        );
        this.scrollToBottom();
      });
      return;
    }

    // Fallback: legacy DOM-based approach for pre-existing elements
    const box = this.toolEls.get(id);
    if (!box) return;
    const hdr = box.querySelector('.co-ober-tool-call-header') as HTMLElement;
    const statEl = hdr.querySelector('.tc-stat') as HTMLElement;

    if (rawInput) {
      const fileEl = hdr.querySelector('.tc-file') as HTMLElement;
      if (fileEl) {
        const rawPath = (locations?.[0]?.path ?? rawInput.file_path ?? rawInput.filePath ?? rawInput.path) as string | undefined;
        if (rawPath) {
          fileEl.textContent = rawPath.split(/[\\/]/).pop() ?? rawPath;
        }
      }
    }

    const body = box.querySelector('.co-ober-tool-call-body') as HTMLElement;

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
          this.renderLegacyDiff(body, item.oldText, item.newText);
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

  /**
   * Legacy inline diff — used only when ToolCallState is unavailable
   * (e.g., tool calls created before the new rendering was adopted).
   */
  private renderLegacyDiff(body: HTMLElement, oldText: string, newText: string): void {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    const maxLen = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < maxLen; i++) {
      if (oldLines[i] === undefined) {
        const line = body.createDiv({ cls: 'diff-line added' });
        line.createSpan({ cls: 'diff-marker', text: '+' });
        line.createSpan({ text: newLines[i] });
      } else if (newLines[i] === undefined) {
        const line = body.createDiv({ cls: 'diff-line removed' });
        line.createSpan({ cls: 'diff-marker', text: '-' });
        line.createSpan({ text: oldLines[i] });
      } else if (oldLines[i] !== newLines[i]) {
        const rmLine = body.createDiv({ cls: 'diff-line removed' });
        rmLine.createSpan({ cls: 'diff-marker', text: '-' });
        rmLine.createSpan({ text: oldLines[i] });
        const addLine = body.createDiv({ cls: 'diff-line added' });
        addLine.createSpan({ cls: 'diff-marker', text: '+' });
        addLine.createSpan({ text: newLines[i] });
      } else {
        const line = body.createDiv({ cls: 'diff-line context' });
        line.createSpan({ cls: 'diff-marker', text: ' ' });
        line.createSpan({ text: oldLines[i] });
      }
    }
  }

  setPlanEntries(entries: Array<{ content: string; status: string; priority?: string }>): void {
    if (!this.planEl) {
      this.planEl = this.container.createDiv({ cls: 'co-ober-plan-panel' });
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
    const wrap = this.container.createDiv({ cls: 'co-ober-msg assistant' });
    const errorEl = wrap.createDiv({ cls: 'co-ober-error' });
    errorEl.createSpan({ cls: 'co-ober-error-text', text });

    if (actionLabel && actionCallback) {
      const btn = errorEl.createEl('button', {
        cls: 'co-ober-error-action',
        text: actionLabel,
      });
      btn.onclick = () => {
        btn.disabled = true;
        btn.textContent = '...';
        void (async () => {
          try {
            await actionCallback();
          } finally {
            btn.disabled = false;
            btn.textContent = actionLabel;
          }
        })();
      };
    }

    this.scrollToBottom();
  }

  showUsage(usage: UsageInfo): void {
    // Ensure we have a wrap to attach usage to (may be null if only tool calls, no text)
    if (!this.currentAssistantWrap) {
      const wrap = this.container.createDiv({ cls: 'co-ober-msg assistant' });
      this.currentAssistantWrap = wrap;
    }
    const target = this.currentAssistantWrap;

    target.querySelector('.co-ober-usage')?.remove();
    const el = target.createDiv({ cls: 'co-ober-usage' });

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

  private formatUsageTitle(usage: UsageInfo): string {
    const labels = t().usage;
    return `${labels.model}: ${usage.modelId ?? '?'} | ${labels.input}: ${usage.inputTokens}, ${labels.output}: ${usage.outputTokens}${usage.thoughtTokens ? `, ${labels.thinking}: ${usage.thoughtTokens}` : ''}`;
  }

  private formatTimestamp(ts: number): string {
    const date = new Date(ts);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ============================================================
  // Phase 3 — Structured message rendering
  // ============================================================

  /**
   * Render a full structured message using contentBlocks.
   * Falls back to legacy rendering when contentBlocks is absent.
   */
  renderStructuredMessage(msg: SerializedMessage, parentEl?: HTMLElement): HTMLElement {
    const wrap = parentEl ?? this.container.createDiv({ cls: 'co-ober-msg assistant' });

    // If no contentBlocks, use legacy rendering
    if (!msg.contentBlocks || msg.contentBlocks.length === 0) {
      if (msg.content) {
        const body = wrap.createDiv({ cls: 'co-ober-msg-body' });
        this.renderInline(body, msg.content);
      }
      return wrap;
    }

    // Duration + interrupt footer
    if (msg.durationSeconds || msg.isInterrupt) {
      const footer = wrap.createDiv({ cls: 'co-ober-response-footer' });
      if (msg.durationSeconds) {
        footer.createSpan({ cls: 'co-ober-baked-duration', text: this.formatDuration(msg.durationSeconds) });
      }
      if (msg.isInterrupt) {
        if (msg.durationSeconds) footer.createSpan({ cls: 'footer-dot' });
        footer.createSpan({ cls: 'co-ober-interrupt-badge', text: 'interrupted' });
      }
    }

    // Render blocks in order
    const contentContainer = wrap.createDiv({ cls: 'co-ober-message-content' });
    for (const block of msg.contentBlocks) {
      this.renderContentBlock(contentContainer, block);
    }

    return wrap;
  }

  /**
   * Render a single content block into the parent element.
   */
  private renderContentBlock(parentEl: HTMLElement, block: ContentBlock): void {
    switch (block.type) {
      case 'thinking':
        renderStoredThinkingBlock(parentEl, block.text ?? '', block.duration);
        break;

      case 'text': {
        if (!block.text) break;
        const textBlock = parentEl.createDiv({ cls: 'co-ober-text-block' });
        const body = textBlock.createDiv({ cls: 'co-ober-msg-body' });
        this.renderInline(body, block.text);
        this.addTextCopyButton(textBlock, block.text);
        break;
      }

      case 'tool_use': {
        // tool_use blocks reference existing tool calls already rendered via addToolCall/updateToolCall.
        // If the tool call exists in our map, we just ensure it's visible.
        // Otherwise, render a placeholder.
        if (block.toolCallId && this.toolEls.has(block.toolCallId)) {
          const existing = this.toolEls.get(block.toolCallId);
          if (existing && existing.parentElement !== parentEl) {
            parentEl.appendChild(existing);
          }
        } else if (block.toolCallId) {
          // Fallback: render a minimal placeholder
          const placeholder = parentEl.createDiv({ cls: 'co-ober-tool-call' });
          placeholder.dataset.toolId = block.toolCallId;
          const hdr = placeholder.createDiv({ cls: 'co-ober-tool-call-header' });
          hdr.createSpan({ text: `[tool: ${block.toolCallId}]`, cls: 'tc-kind' });
        }
        break;
      }

      case 'context_compacted':
        this.renderCompactBoundary(parentEl);
        break;

      case 'subagent':
        this.renderSubagentBlock(parentEl, block);
        break;
    }
  }

  /**
   * Render markdown into a container element.
   * Catches errors and falls back to plain text.
   */
  renderInline(el: HTMLElement, markdown: string): void {
    if (!markdown) return;
    const placeholder = this.doc.createElement('div');
    el.appendChild(placeholder);
    MarkdownRenderer.render(
      this.app,
      markdown,
      placeholder,
      this.app.vault.getRoot().path,
      this.container as unknown as Component,
    ).catch(() => {
      el.textContent = markdown;
    });
  }

  /**
   * Render a compact boundary visual separator.
   */
  renderCompactBoundary(parentEl: HTMLElement): void {
    const boundary = parentEl.createDiv({ cls: 'co-ober-compact-boundary' });
    boundary.createSpan({ cls: 'compact-icon', text: '⋯' });
  }

  /**
   * Render a sub-agent block (stub).
   */
  renderSubagentBlock(parentEl: HTMLElement, block: ContentBlock): void {
    const info = block.subagentInfo;
    if (!info) {
      parentEl.createDiv({ cls: 'co-ober-subagent-block', text: 'sub-agent' });
      return;
    }
    const el = parentEl.createDiv({ cls: 'co-ober-subagent-block' });
    el.createSpan({ cls: 'subagent-name', text: info.name });
    if (info.summary) {
      el.createSpan({ text: ` — ${info.summary}` });
    }
    const statusMap: Record<string, string> = { running: '⟳', completed: '✓', failed: '✗' };
    el.createSpan({ text: ` ${statusMap[info.status] ?? '?'}` });
  }

  /**
   * Add a text copy button to a text block (shown on hover).
   */
  addTextCopyButton(textEl: HTMLElement, markdown: string): void {
    const btn = this.doc.createElement('button');
    btn.className = 'co-ober-text-copy-btn';
    btn.textContent = t().copy.button;
    btn.onclick = () => {
      void navigator.clipboard.writeText(markdown);
      btn.textContent = t().copy.copied;
      window.setTimeout(() => { btn.textContent = t().copy.button; }, 1500);
    };
    textEl.appendChild(btn);
  }

  /**
   * Format seconds into a human-readable duration string.
   * Examples: "2m 15s", "45s", "1h 30m"
   */
  formatDuration(seconds: number): string {
    if (seconds <= 0) return '0s';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const parts: string[] = [];
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    if (s > 0 || parts.length === 0) parts.push(`${s}s`);
    return parts.join(' ');
  }
}