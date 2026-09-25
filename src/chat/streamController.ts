/**
 * StreamController — bridges ACP streaming updates to ChatRenderer.
 *
 * Handles content block ordering so messages render text + tool calls
 * in the correct order when replayed.
 *
 * @since Phase 1 (refactored)
 */

import type {
  NormalizedUpdate,
  SessionConfigOption,
  ModeOption,
  AvailableCommand,
  ModelOption,
  ToolCallContent,
  ToolKind,
  ImageAttachment,
  ContentBlock,
} from '../types';
import type { ChatState } from './chatState';
import type { SerializedMessage } from '../types';
import type { ChatRenderer } from '../view/renderer';
import type { SyncEngine } from '../sync/engine';
import type { SyncContext } from '../sync/templates';
import type { SessionStore } from './session';
import { t } from '../i18n/index';
import { STREAM_SAVE_DEBOUNCE_MS } from '../constants';

export interface StreamControllerDeps {
  state: ChatState;
  renderer: ChatRenderer;
  syncEngine: SyncEngine;
  sessionStore: SessionStore;
  getSessionId: () => string | null;
  onConfigUpdate?: (configOptions: SessionConfigOption[]) => void;
  onModeUpdate?: (currentModeId: string | null, availableModes: ModeOption[]) => void;
  onModelsUpdate?: (currentModelId: string | null, availableModels: ModelOption[]) => void;
  onCommandsUpdate?: (commands: AvailableCommand[]) => void;
  onUsageUpdate?: () => void;
  onSyncFailure?: (message: string) => void;
}

export class StreamController {
  private deps: StreamControllerDeps;
  private syncedToolCalls = new Set<string>();
  // Live message objects keyed per `sessionId:messageId:type`. Object
  // references (not array indices) so a mid-stream prune — which rewrites
  // session.messages — cannot redirect updates onto the wrong message.
  private assistantMessages = new Map<string, SerializedMessage>();
  private saveTimer: number | null = null;
  private activeSave: Promise<void> | null = null;
  private disposed = false;

  // Track content block order for the current assistant message.
  // Tool blocks are shared objects mutated in place as calls complete, so
  // persisted messages carry the final status for faithful restore.
  private currentContentBlocks: ContentBlock[] = [];
  private toolBlocks = new Map<string, ContentBlock>();
  // Phase 4 — tool call buffering
  private pendingToolBuffer: Array<{
    toolCallId: string;
    title: string;
    toolKind: ToolKind;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    rawInput?: Record<string, unknown>;
    rawOutput?: Record<string, unknown>;
    locations?: { path: string }[];
    contents: ToolCallContent[];
  }> = [];
  // Frames already surfaced as a persisted placeholder, keyed messageId:type.
  private unsupportedChunks = new Set<string>();
  // Agent images already written to the transcript, keyed per payload, so a
  // redelivered frame cannot duplicate the (heavy) base64 in data.json.
  private persistedImages = new Set<string>();

  constructor(deps: StreamControllerDeps) {
    this.deps = deps;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      await this.persist();
      return;
    }
    await this.activeSave;
  }

  handleChunk(ch: NormalizedUpdate): void {
    const { state, renderer } = this.deps;

    // Flush any buffered pending tool calls before handling non-tool events,
    // to keep tool calls from interleaving mid-stream.
    if (ch.kind !== 'tool_call_snapshot' || (ch.status !== 'pending' && ch.status !== 'in_progress')) {
      this.flushToolBuffer();
    }

    switch (ch.kind) {
      case 'message_chunk': {
        if (ch.role === 'user') break;
        renderer.removeAssistantPlaceholder();
        if (ch.role === 'agent') {
          // Finalize thinking block before switching to agent text
          renderer.finalizeCurrentThinking();
          if (ch.content?.type === 'image' && ch.content.mimeType && ch.content.data) {
            renderer.appendAssistantImage(ch.content.mimeType, ch.content.data);
            this.persistAssistantImage(ch.messageId, ch.content.mimeType, ch.content.data);
          } else if (!ch.content) {
            renderer.appendText(ch.chunkText, ch.messageId);
            this.saveAssistantChunk(ch.messageId, ch.accumulatedText, 'text');
          } else {
            this.persistUnsupportedChunk(ch.messageId, ch.content.type);
          }
        } else if (ch.role === 'thought') {
          // Non-text thinking payloads carry nothing to render.
          if (ch.content) break;
          // Flush any pending text render before switching to thinking content
          renderer.flushTextRender().catch(() => {});
          renderer.appendThinking(ch.chunkText, ch.messageId);
          this.saveAssistantChunk(ch.messageId, ch.accumulatedText, 'thinking');
        }
        break;
      }
      case 'tool_call_snapshot': {
        if (ch.status === 'pending' || ch.status === 'in_progress') {
          // Buffer pending/in_progress tool calls to prevent
          // interleaving mid-response during streaming.
          this.pendingToolBuffer.push({ ...ch });
        } else {
          // Flush any buffered pending tools, then update completed/failed
          this.flushToolBuffer();
          renderer.updateToolCall(
            ch.toolCallId,
            ch.status,
            ch.rawOutput,
            ch.contents,
            ch.rawInput,
            ch.locations,
            ch.toolKind,
          );
          // Safety net: ensure tool is collapsed on final states
          renderer.collapseToolCall(ch.toolCallId);
          const block = this.toolBlocks.get(ch.toolCallId);
          if (block) {
            block.toolStatus = ch.status === 'failed' ? 'failed' : 'completed';
            if (ch.toolKind) block.toolKind = ch.toolKind;
          }
        }

        if ((ch.status === 'completed' || ch.status === 'failed') && !this.syncedToolCalls.has(ch.toolCallId)) {
          this.syncedToolCalls.add(ch.toolCallId);
          const firstContent = ch.contents?.[0];
          const contentText =
            firstContent?.type === 'content' && firstContent.content?.type === 'text' ? firstContent.content.text : '';
          const ctx: SyncContext = {
            toolCallId: ch.toolCallId,
            toolName: ch.toolName ?? ch.toolKind,
            toolStatus: ch.status,
            rawInput: ch.rawInput,
            rawOutput: ch.rawOutput,
            content: contentText,
          };
          this.deps.syncEngine
            .process(ctx)
            .then((failures) => {
              if (this.disposed) return;
              for (const failure of failures) {
                this.deps.onSyncFailure?.(
                  t()
                    .sync.ruleFailed.replace('{rule}', failure.rule.toolName)
                    .replace('{error}', failure.error.message),
                );
              }
            })
            .catch((e) => {
              if (this.disposed) return;
              console.error('[co-ober] sync failed:', e);
              this.deps.onSyncFailure?.(e instanceof Error ? e.message : String(e));
            });
        }
        break;
      }
      case 'plan': {
        renderer.setPlanEntries(ch.entries);
        state.lastPlanUpdateAt = Date.now();
        break;
      }
      case 'config_options': {
        state.configOptions = ch.configOptions;
        this.deps.onConfigUpdate?.(ch.configOptions);
        break;
      }
      case 'commands': {
        state.availableCommands = ch.commands;
        this.deps.onCommandsUpdate?.(ch.commands);
        break;
      }
      case 'usage': {
        if (state.usage) {
          if (ch.cost) state.usage.cost = ch.cost;
          if (ch.size) state.usage.contextWindow = ch.size;
          if (ch.used) state.usage.contextTokens = ch.used;
        } else {
          state.usage = {
            totalTokens: ch.totalTokens ?? ch.used ?? 0,
            inputTokens: ch.inputTokens ?? 0,
            outputTokens: ch.outputTokens ?? 0,
            thoughtTokens: ch.thoughtTokens,
            cost: ch.cost,
            contextWindow: ch.size,
            contextTokens: ch.used,
          };
        }
        this.deps.onUsageUpdate?.();
        break;
      }
      case 'mode': {
        if (ch.currentModeId !== null) state.currentModeId = ch.currentModeId;
        if (ch.availableModes) state.availableModes = ch.availableModes;
        this.deps.onModeUpdate?.(state.currentModeId, state.availableModes);
        break;
      }
      case 'model': {
        if (ch.currentModelId !== null) state.currentModelId = ch.currentModelId;
        if (ch.availableModels) state.availableModels = ch.availableModels;
        this.deps.onModelsUpdate?.(state.currentModelId, state.availableModels);
        break;
      }
      case 'session_info': {
        const sid = ch.sessionId ?? this.deps.getSessionId();
        if (sid && ch.title) {
          const session = this.deps.sessionStore.get(sid);
          if (session) {
            session.title = ch.title;
            this.scheduleSave();
          }
        }
        break;
      }
      case 'notice': {
        const labels: Record<string, string> = {
          warning: t().stream.noticeWarning,
          error: t().stream.noticeError,
        };
        const label = labels[ch.level];
        renderer.addSystemMessage(label ? `${label}: ${ch.message}` : ch.message);
        break;
      }
      case 'compaction': {
        // Boundary block: rendered now and persisted so a restored
        // transcript still shows where the context was compacted.
        renderer.addSystemMessage(t().stream.compacted);
        this.saveMessage('assistant', t().stream.compacted, 'text');
        break;
      }
    }
  }

  reset(): void {
    this.finalizeBufferedToolCalls();
    this.syncedToolCalls.clear();
    this.assistantMessages.clear();
    this.pendingToolBuffer = [];
    this.currentContentBlocks = [];
    this.toolBlocks.clear();
    this.unsupportedChunks.clear();
    this.persistedImages.clear();
    this.deps.state.resetStreamingState();
  }

  /**
   * New turn in the same session: drop the previous turn's block bookkeeping
   * so stale tool calls from an interrupted turn (Stop skips the finally-block
   * finalize) can't leak into the next assistant message. Message references
   * stay — the next turn always carries a fresh messageId.
   */
  beginTurn(): void {
    this.pendingToolBuffer = [];
    this.currentContentBlocks = [];
    this.toolBlocks.clear();
  }

  /**
   * Render any buffered pending/in_progress tool calls and put them in a
   * terminal state, so a turn that ends (or dies) mid-tool never loses the
   * call or leaves a permanent spinner.
   */
  finalizeBufferedToolCalls(): void {
    if (this.pendingToolBuffer.length === 0) return;
    const ids = this.pendingToolBuffer.map((tc) => tc.toolCallId);
    this.flushToolBuffer();
    for (const id of ids) {
      this.deps.renderer.updateToolCall(id, 'failed');
      const block = this.toolBlocks.get(id);
      if (block) block.toolStatus = 'failed';
    }
  }

  /**
   * Flush buffered pending tool calls to the renderer.
   * Called before handling any non-pending event so tool calls
   * appear in sequence rather than interleaved mid-stream.
   */
  private flushToolBuffer(): void {
    if (this.pendingToolBuffer.length === 0) return;
    const { renderer } = this.deps;
    for (const tc of this.pendingToolBuffer) {
      renderer.addToolCall(tc.toolCallId, tc.title, tc.toolKind, tc.rawInput, tc.locations);
      // Track tool call in content blocks for ordering, with enough
      // metadata (title/kind/status) to re-render it after a restore.
      const block: ContentBlock = {
        type: 'tool_use',
        toolCallId: tc.toolCallId,
        toolTitle: tc.title,
        toolKind: tc.toolKind,
        toolStatus: tc.status === 'in_progress' ? 'in_progress' : 'pending',
      };
      this.currentContentBlocks.push(block);
      this.toolBlocks.set(tc.toolCallId, block);
    }
    this.pendingToolBuffer = [];
  }

  private saveAssistantChunk(messageId: string, accumulatedText: string, type: 'text' | 'thinking'): void {
    const sessionId = this.deps.getSessionId();
    if (!sessionId) return;

    const key = `${sessionId}:${messageId}:${type}`;
    const tracked = this.assistantMessages.get(key);

    if (!tracked) {
      this.deps.sessionStore.getOrCreate(sessionId);
      const session = this.deps.sessionStore.get(sessionId);
      if (!session) return;

      // Build content blocks for ordering
      const contentBlocks: ContentBlock[] = [];

      // Add text/thinking content
      if (accumulatedText) {
        contentBlocks.push({ type, text: accumulatedText });
      }

      // Add all tracked tool call blocks (shared objects, so status
      // updates after this message was created still land on it)
      for (const cb of this.currentContentBlocks) {
        if (cb.type === 'tool_use') contentBlocks.push(cb);
      }

      const message: SerializedMessage = {
        role: 'assistant',
        content: accumulatedText,
        type,
        contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined,
        timestamp: Date.now(),
      };
      session.messages.push(message);
      this.assistantMessages.set(key, message);
      session.updatedAt = Date.now();
    } else {
      const session = this.deps.sessionStore.get(sessionId);
      if (!session) return;
      const msg = tracked;
      msg.content = accumulatedText;
      // Update contentBlocks text
      if (msg.contentBlocks) {
        for (const block of msg.contentBlocks) {
          if (block.type === type && block.text !== undefined) {
            block.text = accumulatedText;
          }
        }
      } else {
        msg.contentBlocks = [];
      }
      // Tool calls can flush after this message was created; keep it in sync
      for (const cb of this.currentContentBlocks) {
        if (cb.type === 'tool_use' && !msg.contentBlocks.includes(cb)) {
          msg.contentBlocks.push(cb);
        }
      }
      session.updatedAt = Date.now();
    }
    this.deps.sessionStore.setActive(sessionId);
    this.scheduleSave();
  }

  /**
   * Non-text frames the transcript cannot paint (audio, resource links…)
   * still get one visible, persisted placeholder per message and content
   * type, so the frame survives reload instead of vanishing.
   */
  private persistUnsupportedChunk(messageId: string, type: string): void {
    const key = `${messageId}:${type}`;
    if (this.unsupportedChunks.has(key)) return;
    this.unsupportedChunks.add(key);
    const note = t().stream.unsupportedContent.replace('{type}', type);
    this.deps.renderer.addSystemMessage(note);
    this.saveMessage('assistant', note, 'text');
  }

  /**
   * Agent images are painted live by appendAssistantImage; this writes the
   * same image into the transcript as an image content block so a restored
   * session still shows it. Deduped by payload so a redelivered frame cannot
   * double-store the base64 blob.
   */
  private persistAssistantImage(messageId: string, mimeType: string, data: string): void {
    const key = `${messageId}:${mimeType}:${data.length}:${data.slice(-16)}`;
    if (this.persistedImages.has(key)) return;
    this.persistedImages.add(key);
    this.saveMessage('assistant', '', 'text', [{ type: 'image', mimeType, data }]);
  }

  /**
   * Persist a rendered system line (e.g. a stop-reason badge) so it survives
   * a reload instead of evaporating with the live DOM. The caller renders.
   */
  persistSystemNote(text: string): void {
    const sessionId = this.deps.getSessionId();
    if (!sessionId) return;
    this.deps.sessionStore.getOrCreate(sessionId);
    this.deps.sessionStore.append(sessionId, {
      role: 'system',
      content: text,
      type: 'text',
      timestamp: Date.now(),
    });
    this.scheduleSave();
  }

  saveMessage(
    role: 'user' | 'assistant',
    content: string,
    type: 'text' | 'tool-call' | 'tool-result' | 'thinking',
    contentBlocks?: ContentBlock[],
    images?: ImageAttachment[],
  ): void {
    const sessionId = this.deps.getSessionId();
    if (!sessionId) return;
    this.deps.sessionStore.getOrCreate(sessionId);
    this.deps.sessionStore.append(sessionId, {
      role,
      content,
      type,
      contentBlocks,
      images,
      timestamp: Date.now(),
    });
    this.deps.sessionStore.setActive(sessionId);
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.disposed) return;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.persist();
    }, STREAM_SAVE_DEBOUNCE_MS);
  }

  private persist(): Promise<void> {
    const save = this.deps.sessionStore.save().catch((error: unknown) => {
      console.error('[co-ober] save session:', error);
    });
    this.activeSave = save;
    void save.finally(() => {
      if (this.activeSave === save) this.activeSave = null;
    });
    return save;
  }
}
