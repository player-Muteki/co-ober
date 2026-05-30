import type CopsilotPlugin from '../main';
import type { SessionMeta, SerializedMessage, SerializedSession } from '../types';
import { t } from '../i18n/index';

/** Session store for persisting conversations in Obsidian plugin data */
export interface SessionStore {
  sessions: Map<string, SerializedSession>;
  activeId: string | null;
  get(id: string): SerializedSession | undefined;
  getOrCreate(opencodeSessionId: string): SerializedSession;
  append(id: string, msg: SerializedMessage): void;
  setActive(id: string): void;
  list(): SessionMeta[];
  save(): Promise<void>;
  load(): Promise<void>;
  remove(id: string): void;
}

export function createSessionStore(plugin: CopsilotPlugin): SessionStore {
  const store: SessionStore = {
    sessions: plugin.sessions,
    activeId: plugin.activeSessionId,

    get(id: string): SerializedSession | undefined {
      return this.sessions.get(id);
    },

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
      this.activeId = opencodeSessionId;
      plugin.activeSessionId = opencodeSessionId;
      return session;
    },

    append(id: string, msg: SerializedMessage): void {
      const s = this.sessions.get(id);
      if (!s) return;
      s.messages.push(msg);
      s.updatedAt = Date.now();
    },

    setActive(id: string): void {
      this.activeId = id;
      plugin.activeSessionId = id;
    },

    list(): SessionMeta[] {
      return [...this.sessions.values()].map((s) => ({
        sessionId: s.sessionId,
        title: s.title,
        updatedAt: new Date(s.updatedAt).toISOString(),
      }));
    },

    async save(): Promise<void> {
      plugin.activeSessionId = this.activeId;
      await plugin.savePluginData();
    },

    async load(): Promise<void> {
      // Data is already loaded in plugin.onload(), just sync the active session ID
      this.activeId = plugin.activeSessionId;
    },

    remove(id: string): void {
      this.sessions.delete(id);
      if (this.activeId === id) this.activeId = null;
    },
  };
  return store;
}
