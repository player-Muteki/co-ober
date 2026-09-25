import { ChatState } from './chatState';
import type { StreamController } from './streamController';
import type { ChatRenderer } from '../view/renderer';
import type { ContextRef, PromptPart } from '../types';

/**
 * Per-tab conversation machinery: transcript state, panel renderer and the
 * stream plumbing for one session. Deliberately thin — turn logic lives in
 * the controller; this only owns what must not be shared between tabs.
 */
export class SessionRuntime {
  readonly state = new ChatState();
  streamCtrl!: StreamController;
  busy = false;
  genId = 0;
  sendStartTime = 0;
  /**
   * Prompts waiting for this tab's turn. `painted` marks one whose user bubble
   * and persisted message already exist (it was already sent once), and
   * `images` carries the parts captured then — a re-parked turn must neither
   * draw nor eat anything twice.
   */
  promptQueue: Array<{ text: string; refs: ContextRef[]; painted?: boolean; images?: PromptPart[] }> = [];
  /** Turn content captured for a user-initiated retry (see retryTurn). */
  pendingRetry: { text: string; imageParts: PromptPart[] } | null = null;
  /** Transcript has been painted into this tab's panel (lazy-restore marker). */
  painted = false;
  /** Rebuilt from a saved shell: its transcript is painted on first view. */
  needsRestore = false;
  /** A turn completed while this tab was hidden. */
  unread = false;
  /** Set when a drained turn lost the race for a stream slot and re-queued. */
  capacityParked = false;
  /**
   * Update frames this tab's agent emitted that the transcript could not draw.
   * Counted per tab, because the frames that got lost belong to one conversation.
   */
  droppedFrames = 0;
  /**
   * The /btw scratch thread this tab forked, if any. It is owned here rather
   * than by the view or the controller: a fork outliving the tab that asked
   * for it leaks a live session on the agent side.
   */
  sideChatSessionId: string | null = null;

  constructor(
    readonly tabId: string,
    sessionId: string | null,
    readonly renderer: ChatRenderer,
  ) {
    this.state.sessionId = sessionId;
  }

  /** ChatState stays the single source for the session pointer. */
  get sessionId(): string | null {
    return this.state.sessionId;
  }

  set sessionId(sessionId: string | null) {
    this.state.sessionId = sessionId;
  }
}
