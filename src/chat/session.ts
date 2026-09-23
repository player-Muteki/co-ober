import type { SessionMeta, SerializedMessage, SerializedSession } from '../types';
import { t } from '../i18n/index';
import { MS_PER_DAY } from '../constants';

export interface SessionStore {
  readonly activeId: string | null;
  get(id: string): SerializedSession | undefined;
  getOrCreate(opencodeSessionId: string): SerializedSession;
  append(id: string, msg: SerializedMessage): void;
  rekey(oldId: string, newId: string): void;
  setActive(id: string): void;
  rename(id: string, title: string): boolean;
  list(): SessionMeta[];
  save(): Promise<void>;
  remove(id: string): void;
}

export interface SerializedSessionState {
  sessions: SerializedSession[];
  activeSessionId: string | null;
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

  constructor(private readonly persist: () => Promise<void>) {}

  get activeId(): string | null {
    return this.activeSessionId;
  }

  hydrate(sessions: SerializedSession[], activeSessionId: string | null): void {
    this.sessions.clear();
    for (const session of restoreElidedTextBlocks(sessions)) {
      this.sessions.set(session.sessionId, session);
    }
    this.activeSessionId = activeSessionId;
  }

  snapshot(): SerializedSessionState {
    return {
      sessions: elideRedundantTextBlocks([...this.sessions.values()]),
      activeSessionId: this.activeSessionId,
    };
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
    this.sessions.set(opencodeSessionId, session);
    this.activeSessionId = opencodeSessionId;
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

  list(): SessionMeta[] {
    return [...this.sessions.values()].map((session) => ({
      sessionId: session.sessionId,
      title: session.title,
      updatedAt: new Date(session.updatedAt).toISOString(),
    }));
  }

  save(): Promise<void> {
    return this.persist();
  }

  remove(id: string): void {
    this.sessions.delete(id);
    if (this.activeSessionId === id) this.activeSessionId = null;
  }

  prune({ maxMessages, retentionDays, now = Date.now() }: SessionPruneOptions): void {
    const cutoffTime = now - retentionDays * MS_PER_DAY;
    const messageLimit = Math.max(1, maxMessages);

    for (const [id, session] of this.sessions) {
      if (id !== this.activeSessionId && session.updatedAt < cutoffTime) {
        this.sessions.delete(id);
        continue;
      }

      if (session.messages.length > messageLimit) {
        const retainedCount = messageLimit - 1;
        const firstCount = Math.floor(retainedCount / 2);
        const lastCount = retainedCount - firstCount;
        const truncatedCount = session.messages.length - firstCount - lastCount;
        session.messages = [
          ...session.messages.slice(0, firstCount),
          {
            role: 'system',
            content: `[${truncatedCount} earlier messages truncated]`,
            type: 'text',
            timestamp: session.messages[firstCount]?.timestamp ?? now,
          },
          ...(lastCount > 0 ? session.messages.slice(-lastCount) : []),
        ];
      }
    }
  }
}
