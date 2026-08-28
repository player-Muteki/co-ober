import type { SessionMeta, SerializedMessage, SerializedSession } from '../types';
import { t } from '../i18n/index';
import { MS_PER_DAY } from '../constants';

export interface SessionStore {
  readonly activeId: string | null;
  get(id: string): SerializedSession | undefined;
  getOrCreate(opencodeSessionId: string): SerializedSession;
  append(id: string, msg: SerializedMessage): void;
  setActive(id: string): void;
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
    for (const session of sessions) {
      this.sessions.set(session.sessionId, session);
    }
    this.activeSessionId = activeSessionId;
  }

  snapshot(): SerializedSessionState {
    return {
      sessions: [...this.sessions.values()],
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

  setActive(id: string): void {
    this.activeSessionId = id;
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
