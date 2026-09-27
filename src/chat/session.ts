import type { SessionMeta, SerializedMessage, SerializedSession, TabShell } from '../types';
import { t } from '../i18n/index';
import { MS_PER_DAY, STORED_IMAGE_BUDGET_BYTES } from '../constants';

export interface SessionStore {
  readonly activeId: string | null;
  get(id: string): SerializedSession | undefined;
  getOrCreate(opencodeSessionId: string): SerializedSession;
  append(id: string, msg: SerializedMessage): void;
  rekey(oldId: string, newId: string): void;
  setActive(id: string): void;
  rename(id: string, title: string): boolean;
  setPinned(id: string, pinned: boolean): boolean;
  tabShell(): { openTabs: TabShell[]; activeTabId: string | null };
  hydrateTabShell(openTabs: TabShell[] | undefined, activeTabId: string | null | undefined): void;
  setTabShell(openTabs: TabShell[], activeTabId: string | null): void;
  list(): SessionMeta[];
  save(): Promise<void>;
  remove(id: string): void;
}

export interface SerializedSessionState {
  sessions: SerializedSession[];
  activeSessionId: string | null;
  openTabs?: TabShell[];
  activeTabId?: string | null;
}

export interface SessionPruneOptions {
  maxMessages: number;
  retentionDays: number;
  now?: number;
}

/**
 * Sidecar slimming step 1: an assistant message whose blocks are all plain
 * text duplicates `content` inside `contentBlocks[].text`. Persisted copies
 * drop the blocks and mark the message instead; `restoreElidedTextBlocks`
 * rebuilds them, so in-memory consumers keep seeing real blocks.
 */
export function elideRedundantTextBlocks(sessions: SerializedSession[]): SerializedSession[] {
  return sessions.map((session) => ({
    ...session,
    messages: session.messages.map(elideMessageBlocks),
  }));
}

function elideMessageBlocks(msg: SerializedMessage): SerializedMessage {
  const blocks = msg.contentBlocks;
  if (msg.role !== 'assistant' || msg.blocksElided || !blocks || blocks.length === 0) return msg;
  if (!blocks.every((block) => block.type === 'text')) return msg;
  if (blocks.map((block) => block.text ?? '').join('') !== msg.content) return msg;
  const copy: SerializedMessage = { ...msg };
  delete copy.contentBlocks;
  copy.blocksElided = true;
  return copy;
}

export function restoreElidedTextBlocks(sessions: SerializedSession[]): SerializedSession[] {
  return sessions.map((session) => {
    if (!session.messages.some((msg) => msg.blocksElided)) return session;
    return { ...session, messages: session.messages.map(restoreMessageBlocks) };
  });
}

function restoreMessageBlocks(msg: SerializedMessage): SerializedMessage {
  if (!msg.blocksElided) return msg;
  const copy: SerializedMessage = { ...msg, contentBlocks: [{ type: 'text', text: msg.content }] };
  delete copy.blocksElided;
  return copy;
}

/** Owns persisted chat state independently from the Obsidian plugin lifecycle. */
export class SessionRepository implements SessionStore {
  private readonly sessions = new Map<string, SerializedSession>();
  private activeSessionId: string | null = null;
  private openTabs: TabShell[] = [];
  private activeTabId: string | null = null;

  constructor(private readonly persist: () => Promise<void>) {}

  get activeId(): string | null {
    return this.activeSessionId;
  }

  /** Which conversations were open side by side, and which one was in front. */
  tabShell(): { openTabs: TabShell[]; activeTabId: string | null } {
    return { openTabs: this.openTabs.map((tab) => ({ ...tab })), activeTabId: this.activeTabId };
  }

  hydrateTabShell(openTabs: TabShell[] | undefined, activeTabId: string | null | undefined): void {
    this.openTabs = (openTabs ?? []).map((tab) => ({ ...tab }));
    this.activeTabId = activeTabId ?? null;
  }

  setTabShell(openTabs: TabShell[], activeTabId: string | null): void {
    this.openTabs = openTabs.map((tab) => ({ ...tab }));
    this.activeTabId = activeTabId;
  }

  hydrate(sessions: SerializedSession[], activeSessionId: string | null): void {
    this.sessions.clear();
    for (const session of restoreElidedTextBlocks(sessions)) {
      this.sessions.set(session.sessionId, session);
    }
    this.activeSessionId = activeSessionId;
    // The tab strip belongs to the same snapshot; a hydrate that left stale
    // shells behind would reopen tabs for sessions this set does not contain.
    this.openTabs = [];
    this.activeTabId = null;
  }

  snapshot(pruneOptions?: SessionPruneOptions): SerializedSessionState {
    const sessions = pruneOptions
      ? this.prunedSessionsCopy(pruneOptions)
      : [...this.sessions.values()];
    return {
      sessions: elideRedundantTextBlocks(sessions),
      activeSessionId: this.activeSessionId,
      openTabs: this.openTabs.map((tab) => ({ ...tab })),
      activeTabId: this.activeTabId,
    };
  }

  /**
   * Prune a private copy of every session for the bytes about to hit disk, so
   * retention, truncation and the image budget never reach into the
   * transcripts the user is reading.
   */
  private prunedSessionsCopy(options: SessionPruneOptions): SerializedSession[] {
    const clone = new Map<string, SerializedSession>();
    for (const [id, session] of this.sessions) {
      clone.set(id, { ...session, messages: session.messages.map((msg) => ({ ...msg })) });
    }
    applyPrune(clone, this.exemptSessionIds(), options);
    return [...clone.values()];
  }

  get(id: string): SerializedSession | undefined {
    return this.sessions.get(id);
  }

  getOrCreate(opencodeSessionId: string): SerializedSession {
    let session = this.sessions.get(opencodeSessionId);
    if (session) return session;

    const now = Date.now();
    session = {
      sessionId: opencodeSessionId,
      title: t().session.defaultTitle.replace('{time}', new Date(now).toLocaleTimeString()),
      opencodeSessionId,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    // Ensuring a session exists is not the same as opening it. adoptReplay and
    // a background tab's stream both create here; if this also moved the
    // pointer, a background turn would silently hijack the conversation the
    // user is looking at. Activation is the caller's explicit setActive.
    this.sessions.set(opencodeSessionId, session);
    return session;
  }

  append(id: string, msg: SerializedMessage): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.messages.push(msg);
    session.updatedAt = Date.now();
  }

  /** Move a session entry to a new id, keeping messages and active status. */
  rekey(oldId: string, newId: string): void {
    if (oldId === newId) return;
    const session = this.sessions.get(oldId);
    if (!session) return;
    this.sessions.delete(oldId);
    session.sessionId = newId;
    session.opencodeSessionId = newId;
    this.sessions.set(newId, session);
    if (this.activeSessionId === oldId) this.activeSessionId = newId;
    for (const tab of this.openTabs) {
      if (tab.sessionId === oldId) tab.sessionId = newId;
    }
  }

  setActive(id: string): void {
    this.activeSessionId = id;
  }

  rename(id: string, title: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.title = title;
    session.updatedAt = Date.now();
    return true;
  }

  setPinned(id: string, pinned: boolean): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (pinned) session.pinned = true;
    else delete session.pinned;
    return true;
  }

  /** Pinned conversations first, then most recently active. */
  list(): SessionMeta[] {
    return [...this.sessions.values()]
      .sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) || b.updatedAt - a.updatedAt)
      .map((session) => {
        const meta: SessionMeta = {
          sessionId: session.sessionId,
          title: session.title,
          updatedAt: new Date(session.updatedAt).toISOString(),
        };
        if (session.pinned) meta.pinned = true;
        return meta;
      });
  }

  save(): Promise<void> {
    return this.persist();
  }

  remove(id: string): void {
    this.sessions.delete(id);
    if (this.activeSessionId === id) this.activeSessionId = null;
  }

  prune(options: SessionPruneOptions): void {
    applyPrune(this.sessions, this.exemptSessionIds(), options);
  }

  /**
   * The conversations the user can still reach without opening the session
   * list: the one in front and every tab that was left open. Losing either is
   * indistinguishable from the app eating a chat.
   */
  private exemptSessionIds(): Set<string> {
    const ids = new Set<string>();
    if (this.activeSessionId) ids.add(this.activeSessionId);
    for (const tab of this.openTabs) {
      if (tab.sessionId) ids.add(tab.sessionId);
    }
    return ids;
  }

}

function clampPruneInt(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

/**
 * Retention + truncation + image budget, applied to whichever map it is given:
 * the live store for an explicit `prune()`, a private copy for a save. A bad
 * retentionDays (0, negative, NaN) would delete every closed conversation in
 * one save, so the window and the message cap are floored here rather than
 * trusted from settings.
 */
function applyPrune(
  sessions: Map<string, SerializedSession>,
  exempt: Set<string>,
  { maxMessages, retentionDays, now = Date.now() }: SessionPruneOptions,
): void {
  const messageLimit = clampPruneInt(maxMessages, 200);
  const retention = clampPruneInt(retentionDays, 30);
  const cutoffTime = now - retention * MS_PER_DAY;

  for (const [id, session] of sessions) {
    // Retention may only touch conversations nobody is looking at: a tab
    // that stayed in the background for a month is still an open chat, and
    // its transcript must not be gone the moment it is switched to. A session
    // whose updatedAt is unknown (0 — the value migration gives a repaired
    // record) is spared too: it is not "from 1970", it simply has no date, and
    // deleting it would let the repair silently destroy what just loaded.
    if (!exempt.has(id) && !session.pinned && session.updatedAt > 0 && session.updatedAt < cutoffTime) {
      sessions.delete(id);
      continue;
    }

    if (session.messages.length > messageLimit) {
      // A cap of one leaves no room for both a marker and anything kept: the
      // head/tail split spends its only slot on the note, so a single save
      // would replace the whole transcript — including the turn the reader is
      // in the middle of — with "N messages truncated". Below two slots the
      // window just keeps the newest messages and says nothing about the rest.
      if (messageLimit < 2) {
        session.messages = session.messages.slice(-messageLimit);
        continue;
      }
      const retainedCount = messageLimit - 1;
      const firstCount = Math.floor(retainedCount / 2);
      const lastCount = retainedCount - firstCount;
      const truncatedCount = session.messages.length - firstCount - lastCount;
      session.messages = [
        ...session.messages.slice(0, firstCount),
        {
          role: 'system',
          content: t().session.truncated.replace('{count}', String(truncatedCount)),
          type: 'text',
          timestamp: session.messages[firstCount]?.timestamp ?? now,
        },
        ...(lastCount > 0 ? session.messages.slice(-lastCount) : []),
      ];
    }
  }

  enforceStoredImageBudget(sessions, exempt);
}

/**
 * Base64 images persisted with the transcript are unbounded otherwise —
 * data.json bloat slows every save and eventually breaks it. On each prune,
 * strip whole image payloads (oldest message first) until the stored total
 * fits the budget; the text of the affected messages is untouched.
 *
 * Pinned and open-tab conversations are stripped last: a pinned star means
 * "keep", and gutting the images of the chat currently on screen is a
 * smaller harm than a save that fails for everyone.
 */
export function enforceStoredImageBudget(
  sessions: Map<string, SerializedSession>,
  exempt: Set<string>,
  budgetBytes = STORED_IMAGE_BUDGET_BYTES,
): void {
  const protectedCarriers: Array<{ msg: SerializedMessage; bytes: number }> = [];
  const freeCarriers: Array<{ msg: SerializedMessage; bytes: number }> = [];
  let total = 0;
  for (const [id, session] of sessions) {
    const sinks = exempt.has(id) || session.pinned ? protectedCarriers : freeCarriers;
    for (const msg of session.messages) {
      let bytes = 0;
      for (const block of msg.contentBlocks ?? []) {
        if (block.type === 'image') bytes += block.data?.length ?? 0;
      }
      // Read the size defensively: a payload whose `data` is not a string would
      // otherwise make the total NaN, and every `total <= budget` comparison then
      // reads false — purging every image on disk, exempt ones included.
      for (const image of msg.images ?? []) bytes += typeof image.data === 'string' ? image.data.length : 0;
      if (bytes > 0) {
        total += bytes;
        sinks.push({ msg, bytes });
      }
    }
  }
  if (total <= budgetBytes) return;
  for (const carriers of [freeCarriers, protectedCarriers]) {
    if (total <= budgetBytes) break;
    carriers.sort((a, b) => a.msg.timestamp - b.msg.timestamp);
    for (const { msg, bytes } of carriers) {
      if (total <= budgetBytes) break;
      purgeImagePayload(msg);
      total -= bytes;
    }
  }
}

/** Drops every image payload from one message; leaves a note when nothing else would render. */
function purgeImagePayload(msg: SerializedMessage): void {
  if (msg.contentBlocks) {
    const kept = msg.contentBlocks.filter((block) => block.type !== 'image');
    if (kept.length > 0) msg.contentBlocks = kept;
    else delete msg.contentBlocks;
  }
  if (msg.images) delete msg.images;
  if (!msg.content.trim()) msg.content = t().session.imagePurged;
}
