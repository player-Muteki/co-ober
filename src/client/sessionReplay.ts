import type { NormalizedUpdate, SerializedMessage } from '../types';

/**
 * Accumulates replayed message chunks delivered by the agent while a
 * session/load or session/resume request is in flight, so the transcript
 * can be rendered after the load completes.
 */
export class SessionReplayCollector {
  private readonly order: string[] = [];
  private readonly buckets = new Map<string, { role: 'user' | 'assistant'; type: 'text' | 'thinking'; text: string }>();

  handle(update: NormalizedUpdate): void {
    if (update.kind !== 'message_chunk') return;
    const role = update.role === 'user' ? 'user' : 'assistant';
    const type = update.role === 'thought' ? 'thinking' : 'text';
    const key = `${update.messageId}|${update.role}`;
    const existing = this.buckets.get(key);
    if (existing) {
      existing.text += update.chunkText;
      return;
    }
    this.buckets.set(key, { role, type, text: update.chunkText });
    this.order.push(key);
  }

  finish(): SerializedMessage[] {
    const now = Date.now();
    const messages: SerializedMessage[] = [];
    for (const key of this.order) {
      const bucket = this.buckets.get(key);
      if (!bucket || !bucket.text.trim()) continue;
      messages.push({ role: bucket.role, type: bucket.type, content: bucket.text, timestamp: now });
    }
    return messages;
  }
}
