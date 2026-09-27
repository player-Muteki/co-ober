import type { NormalizedUpdate, SerializedMessage } from '../types';
import { t } from '../i18n/index';

/**
 * Accumulates replayed message chunks delivered by the agent while a
 * session/load or session/resume request is in flight, so the transcript
 * can be rendered after the load completes.
 */
export class SessionReplayCollector {
  private readonly order: string[] = [];
  private readonly buckets = new Map<
    string,
    { role: 'user' | 'assistant'; type: 'text' | 'thinking'; text: string; messageId: string }
  >();

  handle(update: NormalizedUpdate): void {
    if (update.kind === 'compaction') {
      // Keep the compaction boundary visible in the replayed transcript.
      const key = `compaction|${this.order.length}`;
      this.buckets.set(key, { role: 'assistant', type: 'text', text: t().stream.compacted, messageId: key });
      this.order.push(key);
      return;
    }
    if (update.kind !== 'message_chunk') return;
    const role = update.role === 'user' ? 'user' : 'assistant';
    const type = update.role === 'thought' ? 'thinking' : 'text';
    const key = `${update.messageId}|${update.role}`;
    const existing = this.buckets.get(key);
    if (existing) {
      existing.text += update.chunkText;
      return;
    }
    this.buckets.set(key, { role, type, text: update.chunkText, messageId: update.messageId });
    this.order.push(key);
  }

  finish(): SerializedMessage[] {
    const now = Date.now();
    const messages: SerializedMessage[] = [];
    for (const key of this.order) {
      const bucket = this.buckets.get(key);
      if (!bucket || !bucket.text.trim()) continue;
      messages.push({
        role: bucket.role,
        type: bucket.type,
        content: bucket.text,
        timestamp: now,
        nativeMessageId: agentMessageId(bucket.messageId),
      });
    }
    return messages;
  }
}

/**
 * The normalizer mints '#anon-N' for id-less runs and the collector keys a
 * compaction boundary as 'compaction|N'. Neither is an id the agent ever sent,
 * so neither may become a nativeMessageId: writing one to disk breaks the
 * contract that nativeMessageId is the agent's own and hands cost/usage
 * matching an id no agent will echo back on a later load.
 */
function agentMessageId(id: string): string | undefined {
  return id.startsWith('#') || id.startsWith('compaction|') ? undefined : id;
}
