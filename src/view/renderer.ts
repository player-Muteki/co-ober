import type { App } from 'obsidian';
import { MarkdownRenderer, setIcon, type Component } from 'obsidian';
import { t, onLocaleChange, lookupLocaleString } from '../i18n/index';
import type { UsageInfo, ContentBlock, SerializedMessage, ToolCallContent, ImageAttachment, MessageUsage, TurnStats } from '../types';
import { COPY_BUTTON_RESET_MS, MIN_THROUGHPUT_SAMPLE_MS } from '../constants';
import {
  renderLiveThinkingBlock,
  renderStoredThinkingBlock,
  finalizeThinkingBlock,
  appendThinkingContent,
  cleanupThinkingBlock,
  type ThinkingState,
} from './thinkingBlockRenderer';
import { collapseElement } from './collapsible';
import { openImagePreview } from './imagePreview';
import {
  createToolCallElement,
  updateToolCallElement,
  getToolDisplayName,
  type ToolCallState,
} from './ToolCallRenderer';

export interface RewindHandlers {
  onRegenerate(ordinal: number): void;
  onEditResend(ordinal: number, text: string): void;
}

/** Compact one-line cost/token summary for a restored assistant message. */
export function formatMessageUsage(usage: MessageUsage): string {
  const parts: string[] = [];
  if (usage.inputTokens) parts.push(`↑${usage.inputTokens}`);
  if (usage.outputTokens) parts.push(`↓${usage.outputTokens}`);
  if (!parts.length && usage.totalTokens) parts.push(`${usage.totalTokens} ${t().usage.tokensUnit}`);
  if (usage.cost && usage.cost > 0) parts.push(`${currencySymbol(usage.costCurrency)}${usage.cost.toFixed(4)}`);
  return parts.join(' · ');
}

/**
 * Glyph for a currency code; unknown codes render as "CODE " so a non-USD
 * amount is never misread as dollars.
 */
export function currencySymbol(currency?: string): string {
  switch (currency) {
    case 'CNY':
    case 'JPY':
      return '¥';
    case 'EUR':
      return '€';
    case 'GBP':
      return '£';
    case 'USD':
    case undefined:
      return '$';
    default:
      return `${currency} `;
  }
}

/**
 * Context-window occupancy clamped to 0..100; null when the window size is
 * unknown. Single source of truth for the header meter and the usage line.
 */
export function contextPercentage(usage: Pick<UsageInfo, 'contextTokens' | 'contextWindow'>): number | null {
  const window = usage.contextWindow ?? 0;
  const used = usage.contextTokens ?? 0;
  if (window <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((used / window) * 100)));
}

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

  // ---- User-turn rewind actions ----
  private userTurnCount = 0;
  private rewindHandlers: RewindHandlers | null = null;

  // ---- Three-layer render frame scheduling ----
  // Layer 1: Text render pipeline (requestAnimationFrame + Promise)
  private textRenderFrame: number | null = null;
  private textRenderPromise: Promise<void> | null = null;
  private resolveTextRender: (() => void) | null = null;
  private isTextRenderRunning = false;

  // Layer 3: Tool output per-frame scheduling
  private toolRenderFrames = new Map<string, number>();

  // Structured tool call states
  private toolCallStates = new Map<string, ToolCallState>();

  // Throttled thinking markdown render (RAF-based, ~16ms between frames)
  private thinkingRenderFrame: number | null = null;

  constructor(container: HTMLDivElement, app: App, shouldAutoScroll: () => boolean = () => true) {
    this.container = container;
    this.app = app;
    this.doc = container.ownerDocument ?? activeDocument;
    this.shouldAutoScroll = shouldAutoScroll;
    this.unsubscribeLocale = onLocaleChange(() => this.refreshLocale());
    this.container.addEventListener('click', this.imageClickHandler);
  }

  private imageClickHandler = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    const img = target?.closest?.('img');
    if (!img) return;
    if (img.closest('.co-ober-img-overlay')) return;
    const src = img.getAttribute('src') || img.getAttribute('data-src');
    if (!src) return;
    openImagePreview(src, img.getAttribute('alt') ?? undefined);
  };

  dispose(): void {
    this.cancelTextRender();
    this.cancelThinkingRender();
    this.cancelAllToolRenders();
    this.unsubscribeLocale();
    this.container.removeEventListener('click', this.imageClickHandler);
  }

  clear(): void {
    this.cancelTextRender();
    this.cancelThinkingRender();
    this.cancelAllToolRenders();

    this.container.empty();
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
    this.userTurnCount = 0;
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

  addUserMessage(text: string, timestamp?: number, images?: ImageAttachment[]): void {
    const wrap = this.container.createDiv({ cls: 'co-ober-msg user' });
    wrap.dataset.timestamp = this.formatTimestamp(timestamp ?? Date.now());
    const body = wrap.createDiv({ cls: 'co-ober-msg-body' });
    body.textContent = text;
    if (text) this.addTextCopyButton(wrap, text);
    if (images && images.length > 0) {
      const gallery = wrap.createDiv({ cls: 'co-ober-user-images' });
      for (const img of images) {
        gallery.createEl('img', {
          cls: 'co-ober-user-image',
          attr: { src: `data:${img.mimeType};base64,${img.data}`, alt: img.mimeType },
        });
      }
    }
    this.userTurnCount++;
    if (this.rewindHandlers) this.addUserTurnActions(wrap, body, this.userTurnCount);
    this.scrollToBottom();
  }

  setRewindHandlers(handlers: RewindHandlers | null): void {
    this.rewindHandlers = handlers;
  }

  private addUserTurnActions(wrap: HTMLDivElement, body: HTMLDivElement, ordinal: number): void {
    const handlers = this.rewindHandlers;
    if (!handlers) return;
    const actions = wrap.createDiv({ cls: 'co-ober-user-actions' });

    const regenBtn = actions.createEl('button', { cls: 'co-ober-user-action-btn' });
    setIcon(regenBtn, 'rotate-cw');
    regenBtn.title = t().rewind.regenerate;
    regenBtn.dataset.i18nTitle = 'rewind.regenerate';
    regenBtn.onclick = () => handlers.onRegenerate(ordinal);

    const editBtn = actions.createEl('button', { cls: 'co-ober-user-action-btn' });
    setIcon(editBtn, 'pencil');
    editBtn.title = t().rewind.editResend;
    editBtn.dataset.i18nTitle = 'rewind.editResend';
    editBtn.onclick = () => this.beginUserTurnEdit(wrap, body, ordinal);
  }

  private beginUserTurnEdit(wrap: HTMLDivElement, body: HTMLDivElement, ordinal: number): void {
    const handlers = this.rewindHandlers;
    if (!handlers) return;
    if (wrap.querySelector('.co-ober-user-edit')) return;

    const editor = wrap.createDiv({ cls: 'co-ober-user-edit' });
    const textarea = editor.createEl('textarea', { cls: 'co-ober-user-edit-input' });
    textarea.value = body.textContent ?? '';
    const btnRow = editor.createDiv({ cls: 'co-ober-user-edit-actions' });

    const submitBtn = btnRow.createEl('button', { cls: 'co-ober-user-action-btn' });
    setIcon(submitBtn, 'check');
    submitBtn.title = t().rewind.submit;
    submitBtn.dataset.i18nTitle = 'rewind.submit';
    submitBtn.onclick = () => {
      const text = textarea.value.trim();
      editor.remove();
      if (!text) return;
      body.textContent = text;
      handlers.onEditResend(ordinal, text);
    };

    const cancelBtn = btnRow.createEl('button', { cls: 'co-ober-user-action-btn' });
    setIcon(cancelBtn, 'x');
    cancelBtn.title = t().rewind.cancel;
    cancelBtn.dataset.i18nTitle = 'rewind.cancel';
    cancelBtn.onclick = () => editor.remove();

    textarea.focus();
  }

  addAssistantPlaceholder(): void {
    if (this.placeholderEl) return;
    const wrap = this.container.createDiv({ cls: 'co-ober-msg assistant' });
    const el = wrap.createDiv({ cls: 'co-ober-loading' });
    el.createDiv({ cls: 'co-ober-spinner' });
    const thinkingEl = el.createSpan({ text: t().loading.thinking });
    thinkingEl.dataset.i18nText = 'loading.thinking';
    this.placeholderEl = wrap;
    this.scrollToBottom();
  }

  removeAssistantPlaceholder(): void {
    this.placeholderEl?.remove();
    this.placeholderEl = null;
  }

  // ============================================
  // Whole-turn collapsing
  // ============================================

  /**
   * Fold every completed assistant turn: all intermediate thinking/tool wraps
   * of a turn move into a collapsible summary, leaving the final message of
   * the run visible. Idempotent — collapsed groups are no longer bare
   * assistant wraps, so re-running only picks up new turns.
   */
  collapseTurns(): void {
    const children = Array.from(this.container.children) as HTMLElement[];
    let i = 0;
    while (i < children.length) {
      if (!this.isTurnWrap(children[i])) {
        i++;
        continue;
      }
      let end = i;
      while (end + 1 < children.length && this.isTurnWrap(children[end + 1])) end++;
      if (end > i) this.collapseTurnGroup(children, i, end);
      i = end + 1;
    }
  }

  private isTurnWrap(el: HTMLElement): boolean {
    return el.classList?.contains('co-ober-msg') === true && el.classList.contains('assistant');
  }

  private collapseTurnGroup(children: HTMLElement[], start: number, lastIdx: number): void {
    const hidden = children.slice(start, lastIdx);
    const last = children[lastIdx];
    // Only worth folding when the hidden part actually contains steps
    // (thinking/tool wraps have no .co-ober-msg-body child; text answers do).
    const hasStep = hidden.some((w) => !Array.from(w.children).some((c) => c.classList.contains('co-ober-msg-body')));
    if (!hasStep) return;

    const group = this.doc.createElement('div');
    group.className = 'co-ober-turn-collapsed';
    const header = this.doc.createElement('div');
    header.className = 'co-ober-turn-collapsed-header';
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');
    header.setAttribute('aria-expanded', 'false');
    header.title = t().turnCollapse.toggle;
    header.dataset.i18nTitle = 'turnCollapse.toggle';
    const chevron = this.doc.createElement('span');
    chevron.className = 'co-ober-turn-chevron';
    setIcon(chevron, 'chevron-right');
    header.appendChild(chevron);
    const summary = this.doc.createElement('span');
    summary.className = 'co-ober-turn-summary';
    summary.textContent = t().turnCollapse.summary.replace('{count}', String(hidden.length));
    summary.dataset.i18nCount = 'turnCollapse.summary';
    summary.dataset.count = String(hidden.length);
    header.appendChild(summary);
    const body = this.doc.createElement('div');
    body.className = 'co-ober-turn-collapsed-body';

    const toggle = () => {
      const open = group.classList.toggle('is-open');
      header.setAttribute('aria-expanded', String(open));
    };
    header.addEventListener('click', toggle);
    header.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });

    group.appendChild(header);
    group.appendChild(body);
    last.parentNode?.insertBefore(group, last);
    for (const w of hidden) body.appendChild(w);
  }

  // ============================================
  // Layer 1: Text Render Pipeline
  // ============================================

  appendText(text: string, messageId?: string, timestamp?: number, usage?: MessageUsage, turnStats?: TurnStats): void {
    if (messageId && this.currentAssistantId !== messageId) {
      this.currentAssistantId = messageId;
      this.currentAssistantEl = null;
      this.currentAssistantWrap = null;
      this.currentAssistantText = '';
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
      if (usage || turnStats) this.attachUsageFooter(wrap, usage, turnStats);
    }
    this.scheduleTextRender();
    this.scrollToBottom();
  }

  /** Render an image payload streamed as a non-text agent message chunk. */
  appendAssistantImage(mimeType: string, data: string): void {
    // Close the current text bubble so later chunks of the same message start
    // a fresh one after the image instead of appending to the pre-image text.
    this.currentAssistantEl = null;
    this.currentAssistantWrap = null;
    this.currentAssistantText = '';
    const wrap = this.container.createDiv({ cls: 'co-ober-msg assistant' });
    wrap.dataset.timestamp = this.formatTimestamp(Date.now());
    const body = wrap.createDiv({ cls: 'co-ober-msg-body' });
    body.createEl('img', {
      cls: 'co-ober-assistant-image',
      attr: { src: `data:${mimeType};base64,${data}`, alt: mimeType },
    });
    this.scrollToBottom();
  }

  /** Compact per-message cost/token footer, used when restoring native OpenCode transcripts. */
  private attachUsageFooter(wrap: HTMLElement, usage?: MessageUsage, turnStats?: TurnStats): void {
    const parts: string[] = [];
    const usageText = usage ? formatMessageUsage(usage) : '';
    if (usageText) parts.push(usageText);
    const rate = turnStats ? ChatRenderer.throughput(turnStats.outputTokens, turnStats.durationMs) : null;
    if (rate !== null) parts.push(ChatRenderer.formatRate(rate));
    if (parts.length === 0) return;
    const footer = wrap.createDiv({ cls: 'co-ober-response-footer' });
    footer.createSpan({ cls: 'co-ober-msg-usage', text: parts.join(' · ') });
  }

  /**
   * Append an "Interrupted" indicator to the current assistant message.
   * Rendered as formatted DOM elements directly (not through markdown) to
   * show the red "Interrupted" label with a muted hint text.
   *
   * Like claudian's: "Interrupted · What should I do instead?"
   */
  appendInterruptIndicator(): void {
    // Ensure we have an assistant message container
    if (!this.currentAssistantEl) {
      const wrap = this.container.createDiv({ cls: 'co-ober-msg assistant' });
      this.currentAssistantWrap = wrap;
      this.currentAssistantEl = wrap.createDiv({ cls: 'co-ober-msg-body' });
    }

    // Add interrupted indicator as styled inline elements
    const indicatorEl = this.currentAssistantEl.createDiv({ cls: 'co-ober-interrupted-row' });
    const badgeEl = indicatorEl.createSpan({ cls: 'co-ober-interrupted-badge', text: t().interrupted.badge });
    badgeEl.createSpan({
      cls: 'co-ober-interrupted-hint',
      text: ` \u00B7 ${t().interrupted.hint}`,
    });

    // Also append to the text content so it renders in stored messages
    this.currentAssistantText += `\n\n*${t().interrupted.badge}*`;
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
        // Re-rendering replaces the message DOM, which silently kills any
        // text the user is selecting mid-stream. Defer the pass while a
        // selection lives in the chat until it is released or flushed.
        if (this.hasUserSelectionInView()) {
          void this.scheduleTextRender();
          return;
        }
        void this.executeTextRender();
      });
    }

    return this.textRenderPromise;
  }

  private hasUserSelectionInView(): boolean {
    let selection: Selection | null = null;
    try {
      selection = this.doc.getSelection();
    } catch {
      return false;
    }
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
    const anchor = selection.anchorNode;
    return anchor !== null && this.container.contains(anchor);
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
    const textLengthAtStart = this.currentAssistantText.length;

    try {
      if (this.currentAssistantEl && this.currentAssistantText) {
        const existing = this.currentAssistantEl.querySelector('.md-render-subsystem');
        if (existing) existing.remove();

        const placeholder = this.doc.createElement('div');
        placeholder.addClass('md-render-subsystem');
        // Obsidian themes only style list markers (ordered "1." counters,
        // bullet li::before) under .markdown-rendered; without it, rendered
        // ordered lists lose their numbers.
        placeholder.addClass('markdown-rendered');
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
    const grewDuringPass = this.currentAssistantText.length > textLengthAtStart;
    if (this.currentAssistantEl && this.resolveTextRender) {
      const resolve = this.resolveTextRender;
      this.textRenderPromise = null;
      this.resolveTextRender = null;
      resolve();
    }
    // Chunks that landed mid-await had no frame queued (scheduleTextRender
    // skips while a pass runs) and the promise above belonged to them —
    // without this reschedule their text never paints until the next chunk.
    if (grewDuringPass) void this.scheduleTextRender();
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
      // Mermaid fences are replaced by Obsidian's post-processor; injecting a
      // copy button (or the code-block class) into their <pre> corrupts the
      // rendered diagram, so leave them alone.
      const classes = `${(codeEl as HTMLElement).className ?? ''} ${pre.className ?? ''}`;
      if (/(^|[\s-])mermaid($|[\s-])/.test(classes)) return;

      const btn = this.doc.createElement('button');
      btn.className = 'co-ober-copy-btn';
      btn.textContent = t().copy.button;
      btn.dataset.i18nText = 'copy.button';
      btn.onclick = () => {
        const text = codeEl.textContent || '';
        void navigator.clipboard.writeText(text);
        btn.textContent = t().copy.copied;
        window.setTimeout(() => {
          if (btn.isConnected) btn.textContent = t().copy.button;
        }, COPY_BUTTON_RESET_MS);
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
    // Schedule throttled markdown render so expanded thinking blocks
    // show formatted content (lists, code blocks) in real time
    this.scheduleThinkingRender();
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

  cancelThinkingRender(): void {
    if (this.thinkingRenderFrame !== null) {
      window.cancelAnimationFrame(this.thinkingRenderFrame);
      this.thinkingRenderFrame = null;
    }
    if (this.liveThinkingState) {
      cleanupThinkingBlock(this.liveThinkingState);
      this.liveThinkingState = null;
    }
  }

  /**
   * Schedule a throttled markdown render of the live thinking block body.
   * Uses RAF (max 1 render per frame, ~16ms min interval between renders).
   * Falls back to plain text if markdown rendering fails.
   */
  scheduleThinkingRender(): void {
    if (this.thinkingRenderFrame !== null) {
      window.cancelAnimationFrame(this.thinkingRenderFrame);
    }
    this.thinkingRenderFrame = window.requestAnimationFrame(() => {
      this.thinkingRenderFrame = null;
      const ts = this.liveThinkingState;
      if (!ts || !ts.fullText) return;
      // Only render markdown when the block is expanded to avoid wasted work
      if (ts.wrapper.classList.contains('is-collapsed')) return;
      ts.body.empty();
      MarkdownRenderer.render(
        this.app,
        ts.fullText,
        ts.body,
        this.app.vault.getRoot().path,
        this.container as unknown as Component,
      ).catch(() => {
        ts.body.textContent = ts.fullText;
      });
    });
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
    content?: ToolCallContent[],
    rawInput?: Record<string, unknown>,
    locations?: { path: string }[],
    kind?: string,
  ): void {
    // Use stored ToolCallState from createToolCallElement (with frame scheduling)
    const toolState = this.toolCallStates.get(id);
    if (!toolState) return;
    this.scheduleToolRender(id, () => {
      updateToolCallElement(
        toolState, status, kind ?? toolState.kindEl.textContent?.toLowerCase() ?? '',
        rawOutput, content, rawInput, locations,
      );
      this.scrollToBottom();
    });
  }

  /**
   * Collapse a tool call programmatically. Safe to call even if the
   * tool call doesn't exist or is already collapsed.
   */
  collapseToolCall(id: string): void {
    const toolState = this.toolCallStates.get(id);
    if (!toolState) return;
    collapseElement(toolState.wrapper, toolState.header, toolState.collapsibleState);
  }

  setPlanEntries(entries: Array<{ content: string; status: string; priority?: string }>): void {
    if (!this.planEl) {
      this.planEl = this.container.createDiv({ cls: 'co-ober-plan-panel' });
      const titleEl = this.planEl.createDiv({ cls: 'plan-title', text: t().plan.title });
      titleEl.dataset.i18nText = 'plan.title';
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
    const generated = (usage.outputTokens || 0) + (usage.thoughtTokens || 0);
    const rate = ChatRenderer.throughput(generated, usage.elapsedMs);
    if (rate !== null) parts.push(ChatRenderer.formatRate(rate));
    const pct = contextPercentage(usage);
    if (pct !== null) parts.push(`${pct}%`);
    if (usage.cost?.amount) parts.push(`${currencySymbol(usage.cost.currency)}${usage.cost.amount.toFixed(4)}`);
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
    // Labels rendered at creation time carry their i18n key in a data
    // attribute so a locale switch can relabel the live DOM in place.
    this.container.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
      const label = lookupLocaleString(el.dataset.i18nTitle ?? '');
      if (label !== undefined) el.title = label;
    });
    this.container.querySelectorAll<HTMLElement>('[data-i18n-text]').forEach((el) => {
      const label = lookupLocaleString(el.dataset.i18nText ?? '');
      if (label !== undefined) el.textContent = label;
    });
    this.container.querySelectorAll<HTMLElement>('[data-i18n-count]').forEach((el) => {
      const label = lookupLocaleString(el.dataset.i18nCount ?? '');
      if (label !== undefined) el.textContent = label.replace('{count}', el.dataset.count ?? '');
    });
    this.container.querySelectorAll<HTMLElement>('[data-i18n-kind]').forEach((el) => {
      el.textContent = getToolDisplayName(el.dataset.i18nKind ?? '');
    });
  }

  /**
   * Tokens/second for a turn, computed only from native usage evidence:
   * generated tokens (output + thinking) over the measured wall clock.
   * Returns null when either number is missing or the turn was too short
   * for the rate to mean anything.
   */
  private static throughput(generatedTokens: number, elapsedMs: number | undefined): number | null {
    if (generatedTokens <= 0 || elapsedMs === undefined || elapsedMs < MIN_THROUGHPUT_SAMPLE_MS) return null;
    return generatedTokens / (elapsedMs / 1000);
  }

  /** One rendered form for token rates; "tok/s" is a unit symbol, not prose. */
  private static formatRate(rate: number): string {
    return `${rate.toFixed(1)} tok/s`;
  }

  private formatUsageTitle(usage: UsageInfo): string {
    const labels = t().usage;
    const rate = ChatRenderer.throughput((usage.outputTokens || 0) + (usage.thoughtTokens || 0), usage.elapsedMs);
    const rateSuffix = rate !== null ? ` | ${labels.rate}: ${ChatRenderer.formatRate(rate)}` : '';
    const pct = contextPercentage(usage);
    const ctxSuffix = pct !== null ? ` | ${labels.context}: ${pct}%` : '';
    return `${labels.model}: ${usage.modelId ?? '?'} | ${labels.input}: ${usage.inputTokens}, ${labels.output}: ${usage.outputTokens}${usage.thoughtTokens ? `, ${labels.thinking}: ${usage.thoughtTokens}` : ''}${rateSuffix}${ctxSuffix}`;
  }

  private formatTimestamp(ts: number): string {
    const date = new Date(ts);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ============================================================
  // Phase 3 — Structured message rendering
  // ============================================================

  /**
   * Render a full structured message from its contentBlocks.
   * Used when restoring a session so tool calls and block order survive.
   */
  renderStructuredMessage(msg: SerializedMessage, parentEl?: HTMLElement): HTMLElement {
    const wrap = parentEl ?? this.container.createDiv({ cls: 'co-ober-msg assistant' });
    if (!msg.contentBlocks || msg.contentBlocks.length === 0) return wrap;

    // Duration + interrupt + native usage + turn throughput footer
    const turnRate = msg.turnStats ? ChatRenderer.throughput(msg.turnStats.outputTokens, msg.turnStats.durationMs) : null;
    if (msg.durationSeconds || msg.isInterrupt || msg.usage || turnRate !== null) {
      const footer = wrap.createDiv({ cls: 'co-ober-response-footer' });
      let hasPart = false;
      const dot = () => {
        if (hasPart) footer.createSpan({ cls: 'footer-dot' });
        hasPart = true;
      };
      if (msg.durationSeconds) {
        dot();
        footer.createSpan({ cls: 'co-ober-baked-duration', text: this.formatDuration(msg.durationSeconds) });
      }
      if (msg.isInterrupt) {
        dot();
        footer.createSpan({ cls: 'co-ober-interrupt-badge', text: t().interrupted.badge.toLowerCase() });
      }
      if (msg.usage) {
        const usageText = formatMessageUsage(msg.usage);
        if (usageText) {
          dot();
          footer.createSpan({ cls: 'co-ober-msg-usage', text: usageText });
        }
      }
      if (turnRate !== null) {
        dot();
        footer.createSpan({ cls: 'co-ober-msg-usage', text: ChatRenderer.formatRate(turnRate) });
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

      case 'image': {
        // Mirrors appendAssistantImage's live paint so a restored transcript
        // shows the same inline image.
        if (!block.mimeType || !block.data) break;
        const imgBody = parentEl.createDiv({ cls: 'co-ober-msg-body' });
        imgBody.createEl('img', {
          cls: 'co-ober-assistant-image',
          attr: { src: `data:${block.mimeType};base64,${block.data}`, alt: block.mimeType },
        });
        break;
      }

      case 'tool_use': {
        // tool_use blocks reference existing tool calls already rendered live.
        if (block.toolCallId) {
          const toolState = this.toolCallStates.get(block.toolCallId);
          if (toolState) {
            const { wrapper } = toolState;
            if (wrapper.parentElement !== parentEl) {
              parentEl.appendChild(wrapper);
            }
            break;
          }
          // Restored history: re-render a static element from the block's
          // persisted title/kind/status snapshot.
          const holder = parentEl.createDiv();
          const state = createToolCallElement(
            holder,
            block.toolCallId,
            block.toolKind ?? '',
            block.toolTitle ?? block.toolCallId,
          );
          if (block.toolStatus || block.toolError) {
            const status = block.toolStatus ?? 'failed';
            updateToolCallElement(
              state,
              status,
              block.toolKind ?? '',
              block.toolError ? { error: block.toolError } : undefined,
            );
          }
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
    placeholder.addClass('markdown-rendered');
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
      const stub = parentEl.createDiv({ cls: 'co-ober-subagent-block', text: t().subagent.label });
      stub.dataset.i18nText = 'subagent.label';
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
    btn.dataset.i18nText = 'copy.button';
    btn.onclick = () => {
      void navigator.clipboard.writeText(markdown);
      btn.textContent = t().copy.copied;
      window.setTimeout(() => {
        if (btn.isConnected) btn.textContent = t().copy.button;
      }, COPY_BUTTON_RESET_MS);
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
