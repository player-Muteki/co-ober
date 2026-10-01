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
import { STREAM_SAVE_DEBOUNCE_MS, MAX_TRACKED_ASSISTANT_MESSAGES } from '../constants';

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
  /** A transcript write failed; the tab says so instead of looking saved. */
  onPersistFailure?: () => void;
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
  // The transcript message this turn's chunks landed on, so a Stop can stamp
  // its marker into that message instead of an older answer.
  private lastTurnMessage: SerializedMessage | null = null;
  // Whether this turn has written an assistant message yet. That happens inside
  // saveAssistantChunk, which only a text or thinking chunk triggers, so a turn
  // of nothing but tool calls never writes one and the cards stream away on
  // reload. The finalize sweep reads this to add the missing message exactly
  // once.
  private turnPersisted = false;

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
          // One entry per call: an agent updates the same toolCallId as it
          // goes — pending, then one in_progress after another — and pushing
          // every frame put each copy on the buffer, so the flush drew a card
          // per frame and kept only the last one writable. The earlier copies
          // stayed on screen frozen at the status they were buffered with, and
          // each became its own content block, which is how the duplicates
          // survived a reload.
          // Frames for a call whose card is already on screen don't belong on the
          // buffer: flushing it a second time drew another card under the same
          // id, and only the newest copy could be written to, so the step that
          // was actually running went quiet. Update the one that is there.
          const surfaced = this.toolBlocks.get(ch.toolCallId);
          if (surfaced) {
            const open = surfaced.toolStatus !== 'completed' && surfaced.toolStatus !== 'failed';
            if (open) {
              surfaced.toolStatus = ch.status;
              if (ch.toolKind) surfaced.toolKind = ch.toolKind;
              renderer.updateToolCall(
                ch.toolCallId,
                ch.status,
                ch.rawOutput,
                ch.contents,
                ch.rawInput,
                ch.locations,
                ch.toolKind,
              );
            }
          } else {
            const buffered = this.pendingToolBuffer.find((tc) => tc.toolCallId === ch.toolCallId);
            if (buffered) Object.assign(buffered, ch);
            else this.pendingToolBuffer.push({ ...ch });
          }
        } else {
          // Flush any buffered pending tools, then update completed/failed
          this.flushToolBuffer();
          // An agent that reports only the finished call — no pending or
          // in_progress frame first — still gets a card. Without one there is
          // no element for the update to write into, and the step vanished
          // from the live transcript and from the blocks a reload renders.
          if (!this.toolBlocks.has(ch.toolCallId)) {
            renderer.addToolCall(ch.toolCallId, ch.title || ch.toolCallId, ch.toolKind, ch.rawInput, ch.locations);
            const block: ContentBlock = {
              type: 'tool_use',
              toolCallId: ch.toolCallId,
              toolTitle: ch.title,
              toolKind: ch.toolKind,
              toolStatus: ch.status === 'failed' ? 'failed' : 'completed',
            };
            this.currentContentBlocks.push(block);
            this.toolBlocks.set(ch.toolCallId, block);
          }
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
          // The tool's human-readable result may sit anywhere in `contents`; the
          // renderer scans the whole list for text, and a tool that returns an
          // image, diff or unsupported block before its text leaves the result
          // in a later slot. Reading only slot 0 turned that real text into '' and
          // let the sync note fall through to rawOutput or "(no output)" — the
          // same wrong-source the transcript already refuses to render. Take the
          // first text block the agent actually sent, exactly as the card shows.
          const textContent = ch.contents?.find(
            (item) => item.type === 'content' && item.content?.type === 'text',
          );
          const contentText =
            textContent?.type === 'content' && textContent.content?.type === 'text' ? textContent.content.text : '';
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
          // A reported zero is a reading, not an absence. Truthiness threw the
          // zeros away, so the frame after a compaction — "0 of 200k in use" —
          // left the meter holding the figure from before it, and a free
          // window kept looking nearly full to whoever had just emptied it.
          if (ch.cost !== undefined) state.usage.cost = ch.cost;
          if (ch.size !== undefined) state.usage.contextWindow = ch.size;
          if (ch.used !== undefined) state.usage.contextTokens = ch.used;
          // A later frame that re-reports the token totals is a newer reading,
          // not a duplicate: only cost/size/used were re-read here, so a
          // usage_update carrying an updated input/output/total figure after the
          // first frame was thrown away and the footer kept the stale count.
          if (ch.totalTokens !== undefined) state.usage.totalTokens = ch.totalTokens;
          if (ch.inputTokens !== undefined) state.usage.inputTokens = ch.inputTokens;
          if (ch.outputTokens !== undefined) state.usage.outputTokens = ch.outputTokens;
          if (ch.thoughtTokens !== undefined) state.usage.thoughtTokens = ch.thoughtTokens;
        } else {
          state.usage = {
            // Context occupancy is not a consumption figure. A first frame that
            // only reports `used` must leave the token total unreported (0)
            // rather than stamping the window reading onto the footer's
            // "N tokens", which claims money of work the agent never said it
            // did. The meter reads the window from contextTokens below.
            totalTokens: ch.totalTokens ?? 0,
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
        // transcript still shows where the context was compacted. Persist as a
        // system note, not an assistant message — the live renderer draws this
        // through addSystemMessage, and paintTranscript/export branch on role,
        // so writing the assistant role would reload the boundary as an
        // assistant bubble and label it "Assistant" in the transcript export.
        renderer.addSystemMessage(t().stream.compacted);
        this.persistSystemNote(t().stream.compacted);
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
    this.lastTurnMessage = null;
    this.turnPersisted = false;
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
    this.lastTurnMessage = null;
    this.turnPersisted = false;
  }

  /**
   * The "Interrupted" badge lives in the live DOM only, so a reload showed a
   * half-finished answer as though it were complete. Stamp it into the
   * transcript message this turn was writing to — never onto an older,
   * finished answer, which is why this tracks the turn's own message rather
   * than scanning the transcript backwards.
   */
  persistInterruptMarker(): void {
    const sessionId = this.deps.getSessionId();
    const msg = this.lastTurnMessage;
    if (!sessionId || !msg) return;
    const session = this.deps.sessionStore.get(sessionId);
    if (!session?.messages.includes(msg)) return;
    const marker = `*${t().interrupted.badge}*`;
    if (msg.content.trimEnd().endsWith(marker)) return;
    msg.content = `${msg.content}\n\n${marker}`;
    for (const block of msg.contentBlocks ?? []) {
      if (block.type === msg.type && block.text !== undefined) {
        block.text = `${block.text}\n\n${marker}`;
      }
    }
    session.updatedAt = Date.now();
    this.scheduleSave();
  }

  /**
   * Put every tool call this turn left open into a terminal state, so a turn
   * that ends (or dies) mid-tool never loses the call or leaves a permanent
   * spinner.
   */
  finalizeBufferedToolCalls(): void {
    // The buffer is not the only place an open call hides. Flushing it is what
    // puts a card on screen, so by the time a Stop arrives the call the reader
    // is watching has usually left the buffer already — and this method, which
    // used to return as soon as it was empty, never reached it. The card kept
    // spinning on a turn no agent would ever finish.
    this.flushToolBuffer();
    for (const [id, block] of this.toolBlocks) {
      if (block.toolStatus !== 'pending' && block.toolStatus !== 'in_progress') continue;
      block.toolStatus = 'failed';
      // The interruption is the only reason this call has no output, and a card
      // that fails silently reads as a broken tool rather than a stopped turn.
      this.deps.renderer.updateToolCall(id, 'failed', { error: t().interrupted.badge });
    }
    if (this.currentContentBlocks.length === 0) return;
    if (this.turnPersisted) {
      // A card can surface after its answer was written — the tool frames land
      // between two text chunks — and the message only collects cards the next
      // chunk brings. A turn stopped before that kept its steps on screen and
      // lost them on disk.
      const msg = this.lastTurnMessage;
      if (msg) {
        const blocks = msg.contentBlocks ?? [];
        let added = false;
        for (const cb of this.currentContentBlocks) {
          if (cb.type === 'tool_use' && !blocks.includes(cb)) {
            blocks.push(cb);
            added = true;
          }
        }
        msg.contentBlocks = blocks;
        if (added) this.scheduleSave();
      }
      return;
    }
    this.saveMessage('assistant', '', 'tool-call', [...this.currentContentBlocks]);
    this.turnPersisted = true;
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
      // The status the card was buffered at is handed to the renderer, so a call
      // that is running shows a spinner the moment it appears rather than after
      // its next frame — which, for a short call, is never.
      const status = tc.status === 'in_progress' ? 'in_progress' : 'pending';
      renderer.addToolCall(tc.toolCallId, tc.title, tc.toolKind, tc.rawInput, tc.locations, status);
      // Track tool call in content blocks for ordering, with enough
      // metadata (title/kind/status) to re-render it after a restore.
      const block: ContentBlock = {
        type: 'tool_use',
        toolCallId: tc.toolCallId,
        toolTitle: tc.title,
        toolKind: tc.toolKind,
        toolStatus: status,
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
      this.lastTurnMessage = message;
      this.turnPersisted = true;
      // Insertion-ordered map: evicting the oldest reference keeps a very
      // long session from retaining every assistant message forever.
      if (this.assistantMessages.size > MAX_TRACKED_ASSISTANT_MESSAGES) {
        const oldest = this.assistantMessages.keys().next();
        if (!oldest.done) this.assistantMessages.delete(oldest.value);
      }
      session.updatedAt = Date.now();
    } else {
      const session = this.deps.sessionStore.get(sessionId);
      if (!session) return;
      const msg = tracked;
      if (!session.messages.includes(msg)) {
        // Prune dropped this message from the transcript. A reused
        // messageId must start a fresh entry rather than mutate a detached
        // object nobody can see; re-enter to take the create branch.
        this.assistantMessages.delete(key);
        this.saveAssistantChunk(messageId, accumulatedText, type);
        return;
      }
      this.lastTurnMessage = msg;
      this.turnPersisted = true;
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
    // Which conversation is "current" belongs to the tab strip, not to whoever
    // last wrote a message: a background tab's turn finishing used to move the
    // store's active pointer onto its session, so the composer, the history
    // list and the next view open all answered for a conversation the reader
    // never selected.
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
      // The reply is on screen either way; say that it did not reach the disk.
      this.deps.onPersistFailure?.();
    });
    this.activeSave = save;
    void save.finally(() => {
      if (this.activeSave === save) this.activeSave = null;
    });
    return save;
  }
}
