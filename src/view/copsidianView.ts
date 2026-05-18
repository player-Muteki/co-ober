import { ItemView, WorkspaceLeaf, TFile } from 'obsidian';
import type CopsidianPlugin from '../main';
import { VIEW_TYPE } from '../types';
import type { SessionUpdate, ContextRef, PromptPart } from '../types';
import { ChatRenderer } from './renderer';
import { ChatInput } from '../chat/input';
import { InputToolbar } from '../chat/toolbar';
import { ContextMention } from '../context/mention';
import { SyncEngine } from '../sync/engine';
import type { SyncContext } from '../sync/templates';

export class CopsidianView extends ItemView {
  private messagesEl!: HTMLDivElement;
  private contextChipsEl!: HTMLDivElement;
  private renderer!: ChatRenderer;
  private input: ChatInput | null = null;
  private syncEngine!: SyncEngine;
  private mention!: ContextMention;
  private sessionId: string | null = null;
  private busy = false;
  private sessionDropdown: HTMLDivElement | null = null;
  private syncedToolCalls = new Set<string>();

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: CopsidianPlugin,
  ) { super(leaf); }

  override getViewType(): string { return VIEW_TYPE; }
  override getDisplayText(): string { return 'Copsidian'; }
  override getIcon(): string { return 'bot'; }

  override async onOpen(): Promise<void> {
    const { containerEl: el } = this;
    el.addClass('copsidian-view');
    el.parentElement?.addClass('copsidian-plugin');

    this.mention = new ContextMention(this.plugin.app.vault);
    this.syncEngine = new SyncEngine(this.plugin.app.vault, this.plugin.settings.syncRules);

    // Header
    const header = el.createDiv({ cls: 'copsidian-header' });
    header.createDiv({ text: 'Copsidian', cls: 'copsidian-header-title' });
    const actions = header.createDiv({ cls: 'copsidian-header-actions' });
    actions.createEl('button', { text: '＋ New', cls: 'mod-icon' }).onclick = () => this.newSession();
    actions.createEl('button', { text: '⋯', cls: 'mod-icon' }).onclick = () => this.toggleSessions();

    this.messagesEl = el.createDiv({ cls: 'copsidian-messages' });
    this.renderer = new ChatRenderer(this.messagesEl, this.plugin.app);

    this.contextChipsEl = el.createDiv({ cls: 'copsidian-context-chips' });

    const tbEl = el.createDiv({ cls: 'copsidian-toolbar' });
    new InputToolbar(tbEl, {
      onAgentChange: (a: string) => this.plugin.getClient()?.setMode(this.sessionId!, a).catch(() => {}),
    });

    const inpEl = el.createDiv({ cls: 'copsidian-input-area' });
    this.input = new ChatInput(inpEl, {
      onSend: (text, refs) => this.send(text, refs),
      onToggleMention: () => this.showAC('@'),
      onToggleSlash: () => this.showAC('/'),
    });
  }

  override onClose(): Promise<void> {
    this.contextChipsEl.remove();
    return Promise.resolve();
  }

  private async newSession(): Promise<void> {
    const c = this.plugin.getClient();
    if (!c) return;
    try {
      this.renderer.clear();
      this.syncedToolCalls.clear();
      this.mention = new ContextMention(this.plugin.app.vault);
      this.sessionId = await c.createSession();
    } catch (e) { console.error('[copsidian] newSession:', e); }
  }

  private async toggleSessions(): Promise<void> {
    if (this.sessionDropdown) { this.sessionDropdown.remove(); this.sessionDropdown = null; return; }
    const c = this.plugin.getClient();
    if (!c) return;
    const list = await c.listSessions();
    const dd = this.containerEl.createDiv({ cls: 'copsidian-session-list' });
    for (const s of list) {
      const it = dd.createDiv({ cls: `copsidian-session-item${s.sessionId === this.sessionId ? ' active' : ''}`, text: s.title || s.sessionId });
      it.onclick = () => { this.sessionId = s.sessionId; dd.remove(); this.sessionDropdown = null; };
    }
    this.sessionDropdown = dd;
  }

  private async send(text: string, refs: ContextRef[]): Promise<void> {
    const c = this.plugin.getClient();
    if (!c || !this.sessionId || this.busy) return;

    this.busy = true;
    this.renderer.addUserMessage(text);

    try {
      const parts = await this.parts(text, refs);
      await c.sendMessage(this.sessionId, parts, (ch) => this.onChunk(ch));
    } catch (e: unknown) {
      this.renderer.addError(e instanceof Error ? e.message : String(e));
    } finally { this.busy = false; }
  }

  private async parts(text: string, refs: ContextRef[]): Promise<PromptPart[]> {
    const parts: PromptPart[] = [{ type: 'text', text }];
    if (refs.length > 0) {
      const ctx: string[] = [];
      for (const r of refs) {
        if (r.type === 'note') {
          const f = this.plugin.app.vault.getAbstractFileByPath(r.path);
          if (f instanceof TFile && f.extension === 'md') {
            ctx.push(`=== NOTE: [[${r.name}]] ===\n${await this.plugin.app.vault.read(f)}\n=== END NOTE ===`);
          }
        }
      }
      if (ctx.length) parts.unshift({ type: 'text', text: ctx.join('\n\n') });
    }
    return parts;
  }

  private onChunk(ch: SessionUpdate): void {
    switch (ch.sessionUpdate) {
      case 'agent_message_chunk': this.renderer.appendText((ch as any).content.text); break;
      case 'agent_thought_chunk': this.renderer.appendThinking((ch as any).content.text); break;
      case 'tool_call': {
        const t = ch as any;
        this.renderer.addToolCall(t.toolCallId, t.title, t.kind, t.rawInput);
        break;
      }
      case 'tool_call_update': {
        const t = ch as any;
        this.renderer.updateToolCall(t.toolCallId, t.status, t.rawOutput, t.content);
        // Trigger sync when tool call completes
        if ((t.status === 'completed' || t.status === 'failed') && !this.syncedToolCalls.has(t.toolCallId)) {
          this.syncedToolCalls.add(t.toolCallId);
          const contentText = t.content?.[0]?.content?.text ?? '';
          const ctx: SyncContext = {
            toolCallId: t.toolCallId,
            toolName: t.kind ?? 'unknown',
            toolStatus: t.status,
            rawInput: t.rawInput,
            rawOutput: t.rawOutput,
            content: contentText,
          };
          this.syncEngine.process(ctx).catch(e => {
            console.error('[copsidian] sync failed:', e);
          });
        }
        break;
      }
      case 'plan': this.renderer.setPlanEntries((ch as any).entries); break;
    }
  }

  private showAC(mode: '@' | '/'): void {
    const items: Array<{ value: string; label: string; description?: string }> = [];
    if (mode === '@') {
      const notes = this.mention.listAllNotes();
      for (const n of notes) items.push({ value: n.name, label: `@${n.name}`, description: n.path });
    } else {
      items.push({ value: '/compact', label: '/compact', description: 'compact the session' });
    }
    const ac = this.containerEl.createDiv({ cls: 'copsidian-ac-dropdown' });
    let selIdx = 0;
    const render = () => {
      ac.empty();
      for (let i = 0; i < items.length; i++) {
        const el = ac.createDiv({ cls: `copsidian-ac-item${i === selIdx ? ' selected' : ''}` });
        el.createSpan({ text: items[i].label, cls: 'ac-label' });
        if (items[i].description) el.createSpan({ text: items[i].description, cls: 'ac-desc' });
        el.onclick = () => {
          const val = items[i].value;
          this.input?.appendValue(val + ' ');
          ac.remove();
          this.input?.focus();
        };
      }
    };
    render();
    ac.onkeydown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') { selIdx = (selIdx + 1) % items.length; render(); e.preventDefault(); }
      if (e.key === 'ArrowUp') { selIdx = (selIdx - 1 + items.length) % items.length; render(); e.preventDefault(); }
    };
  }
}
