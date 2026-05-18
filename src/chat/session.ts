import type CopsidianPlugin from '../main';
import type { SessionMeta } from '../types';

export interface SerializedMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  type: 'text' | 'tool-call' | 'tool-result' | 'thinking';
  toolCallId?: string;
  timestamp: number;
}

export interface SerializedSession {
  sessionId: string;
  title: string;
  opencodeSessionId?: string;
  messages: SerializedMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface SessionStore {
  sessions: Map<string, SerializedSession>;
  activeId: string | null;
  create(opencodeSessionId: string): string;
  get(id: string): SerializedSession | undefined;
  append(id: string, msg: SerializedMessage): void;
  setActive(id: string): void;
  list(): SessionMeta[];
  save(): Promise<void>;
  load(): Promise<void>;
  remove(id: string): void;
}

export function createSessionStore(plugin: CopsidianPlugin): SessionStore {
  const store: SessionStore = {
    sessions: new Map(),
    activeId: null,

    create(opencodeSessionId: string): string {
      const id = crypto.randomUUID();
      const now = Date.now();
      this.sessions.set(id, {
        sessionId: id,
        title: `Chat ${new Date(now).toLocaleTimeString()}`,
        opencodeSessionId,
        messages: [],
        createdAt: now,
        updatedAt: now,
      });
      this.activeId = id;
      return id;
    },

    get(id: string): SerializedSession | undefined {
      return this.sessions.get(id);
    },

    append(id: string, msg: SerializedMessage): void {
      const s = this.sessions.get(id);
      if (!s) return;
      s.messages.push(msg);
      s.updatedAt = Date.now();
    },

    setActive(id: string): void {
      this.activeId = id;
    },

    list(): SessionMeta[] {
      return [...this.sessions.values()].map((s) => ({
        sessionId: s.sessionId,
        title: s.title,
        updatedAt: new Date(s.updatedAt).toISOString(),
      }));
    },

    async save(): Promise<void> {
      const data = {
        sessions: [...this.sessions.values()],
        activeId: this.activeId,
      };
      await plugin.saveData(data);
    },

    async load(): Promise<void> {
      const raw = await plugin.loadData();
      const payload = raw as { sessions?: SerializedSession[]; activeId?: string | null } | null;
      if (!payload?.sessions) return;
      this.sessions.clear();
      for (const s of payload.sessions) this.sessions.set(s.sessionId, s);
      this.activeId = payload.activeId ?? null;
    },

    remove(id: string): void {
      this.sessions.delete(id);
      if (this.activeId === id) this.activeId = null;
    },
  };
  return store;
}
