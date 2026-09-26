import type { SessionUpdate, NormalizedUpdate, ChunkContent } from '../types';
import { safeClone } from '../utils/clone';
import { t } from '../i18n/index';

const MAX_ACCUMULATED_MESSAGES = 200;
const MAX_TOOL_CALLS = 100;
const MAX_COMPACTIONS = 50;

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

const TOOL_STATUSES: readonly string[] = ['pending', 'in_progress', 'completed', 'failed'];

// Synthetic ids stand in for the optional ACP `messageId`. They are never
// written to disk, so only same-process uniqueness matters: per-instance
// numbering restarted at 1 on every replay, which folded a session's second
// id-less turn onto the first message.
let anonymousRuns = 0;

/**
 * Agents mint statuses ahead of the four we render ('cancelled' is the
 * common one). Abort-shaped statuses map to failed so they badge terminally;
 * anything else unknown degrades to in_progress so it never fakes completion.
 */
export function normalizeToolStatus(status: string | undefined | null, fallback: ToolCallStatus): ToolCallStatus {
  if (status === undefined || status === null) return fallback;
  if (TOOL_STATUSES.includes(status)) return status as ToolCallStatus;
  if (status === 'cancelled' || status === 'canceled' || status === 'aborted' || status === 'rejected') return 'failed';
  return 'in_progress';
}

export class SessionUpdateNormalizer {
  private readonly accumulatedMessages = new Map<string, { role: 'user' | 'agent' | 'thought'; text: string }>();
  private readonly toolCalls = new Map<string, Extract<NormalizedUpdate, { kind: 'tool_call_snapshot' }>>();
  // v2-alpha compactions are upserts keyed by compactionId: the boundary is
  // pinned at the first frame and must not be re-emitted by later patches.
  private readonly startedCompactions = new Set<string>();
  // Chunks with no `messageId` (an optional, unstable ACP field) still belong
  // to one message: the run they arrive in gets a synthetic id, kept until the
  // role changes or a real id shows up, which starts a new message.
  private anonymousRun: { role: 'user' | 'agent' | 'thought'; messageId: string } | null = null;

  reset(): void {
    this.accumulatedMessages.clear();
    this.toolCalls.clear();
    this.startedCompactions.clear();
    this.anonymousRun = null;
  }

  /** The id one chunk accumulates under: its own, or its run's synthetic one. */
  private idFor(role: 'user' | 'agent' | 'thought', messageId: string | undefined): string {
    if (messageId) {
      this.anonymousRun = null;
      return messageId;
    }
    if (this.anonymousRun?.role === role) return this.anonymousRun.messageId;
    // Process-wide, so a reconnect's fresh normalizer cannot hand the next turn
    // an id a previous turn already persisted under.
    const synthetic = `#anon-${++anonymousRuns}`;
    this.anonymousRun = { role, messageId: synthetic };
    return synthetic;
  }

  /** Evict the oldest entries when the map exceeds the given limit. */
  private trimMap<K, V>(map: Map<K, V>, maxEntries: number): void {
    if (map.size <= maxEntries) return;
    const keysToDelete = [...map.keys()].slice(0, map.size - maxEntries);
    for (const key of keysToDelete) {
      map.delete(key);
    }
  }

  private trimSet(set: Set<string>, maxEntries: number): void {
    if (set.size <= maxEntries) return;
    const toDelete = [...set].slice(0, set.size - maxEntries);
    for (const key of toDelete) {
      set.delete(key);
    }
  }

  /**
   * All normalized updates to deliver for one raw frame. v2-alpha agents can
   * fold config options into `session_info_update`; the view tracks config
   * and session info as separate concerns, so such a frame fans out to both.
   */
  normalizeList(raw: SessionUpdate): NormalizedUpdate[] {
    const primary = this.normalize(raw);
    const list = primary ? [primary] : [];
    if (raw.sessionUpdate === 'session_info_update' && raw.configOptions) {
      list.push({ kind: 'config_options', configOptions: raw.configOptions });
    }
    return list;
  }

  /**
   * Accumulate one streamed chunk. Only `text` content feeds the transcript;
   * non-text payloads ride along on the update so consumers can surface them
   * instead of the frame vanishing.
   */
  private chunkUpdate(role: 'user' | 'agent' | 'thought', messageId: string | undefined, content: ChunkContent): NormalizedUpdate {
    const id = this.idFor(role, messageId);
    const text = content.type === 'text' ? content.text ?? '' : '';
    const existing = this.accumulatedMessages.get(id);
    const accumulatedText = existing ? existing.text + text : text;
    this.accumulatedMessages.set(id, { role, text: accumulatedText });
    this.trimMap(this.accumulatedMessages, MAX_ACCUMULATED_MESSAGES);
    const update: Extract<NormalizedUpdate, { kind: 'message_chunk' }> = {
      kind: 'message_chunk',
      role,
      messageId: id,
      chunkText: text,
      accumulatedText,
    };
    if (!text && content.type !== 'text') update.content = content;
    return update;
  }

  normalize(raw: SessionUpdate): NormalizedUpdate | null {
    switch (raw.sessionUpdate) {
      case 'user_message_chunk':
        return this.chunkUpdate('user', raw.messageId, raw.content);
      case 'agent_message_chunk':
        return this.chunkUpdate('agent', raw.messageId, raw.content);
      case 'agent_thought_chunk':
        return this.chunkUpdate('thought', raw.messageId, raw.content);
      case 'tool_call': {
        const snapshot: Extract<NormalizedUpdate, { kind: 'tool_call_snapshot' }> = {
          kind: 'tool_call_snapshot',
          toolCallId: raw.toolCallId,
          title: raw.title,
          toolName: raw.name,
          toolKind: raw.kind ?? 'other',
          status: normalizeToolStatus(raw.status, 'pending'),
          rawInput: raw.rawInput,
          locations: raw.locations,
          contents: raw.content ? [...raw.content] : [],
        };
        this.toolCalls.set(raw.toolCallId, snapshot);
        this.trimMap(this.toolCalls, MAX_TOOL_CALLS);
        return safeClone(snapshot);
      }
      case 'tool_call_update': {
        let existing = this.toolCalls.get(raw.toolCallId);
        if (!existing) {
          // The originating tool_call was evicted by the trim (or never
          // arrived); rebuilding from the update keeps the tool from being
          // stuck in its last rendered state.
          existing = {
            kind: 'tool_call_snapshot',
            toolCallId: raw.toolCallId,
            title: raw.title ?? raw.toolCallId,
            toolName: raw.name,
            toolKind: raw.kind ?? 'other',
            status: normalizeToolStatus(raw.status, 'completed'),
            contents: raw.content ? [...raw.content] : [],
          };
          this.toolCalls.set(raw.toolCallId, existing);
          this.trimMap(this.toolCalls, MAX_TOOL_CALLS);
        } else if (raw.content) {
          existing.contents = existing.contents.concat(raw.content);
        }

        if (raw.status) existing.status = normalizeToolStatus(raw.status, existing.status);
        if (raw.title) existing.title = raw.title;
        if (raw.name) existing.toolName = raw.name;
        if (raw.kind) existing.toolKind = raw.kind;
        if (raw.rawInput) existing.rawInput = { ...existing.rawInput, ...raw.rawInput };
        if (raw.rawOutput) existing.rawOutput = { ...existing.rawOutput, ...raw.rawOutput };
        if (raw.locations) existing.locations = raw.locations;

        // Completed/failed tool calls are no longer needed for state tracking
        // but keep the latest snapshot for the current stream cycle.
        return safeClone(existing);
      }
      case 'plan':
        return { kind: 'plan', entries: raw.entries };
      case 'config_option_update':
        return { kind: 'config_options', configOptions: raw.configOptions };
      case 'available_commands_update':
        return { kind: 'commands', commands: raw.availableCommands };
      case 'current_mode_update':
        return { kind: 'mode', currentModeId: raw.currentModeId ?? null, availableModes: raw.availableModes ?? [] };
      case 'current_model_update':
        return {
          kind: 'model',
          currentModelId: raw.currentModelId ?? null,
          availableModels: raw.availableModels ?? [],
        };
      case 'session_info_update':
        return { kind: 'session_info', sessionId: raw.sessionId, title: raw.title, cwd: raw.cwd };
      case 'usage_update':
        return {
          kind: 'usage',
          totalTokens: raw.totalTokens,
          inputTokens: raw.inputTokens,
          outputTokens: raw.outputTokens,
          thoughtTokens: raw.thoughtTokens,
          cost: raw.cost,
          used: raw.used,
          size: raw.size,
        };
      case 'notice_update':
        return { kind: 'notice', level: raw.level, message: raw.message };
      case 'compaction_update': {
        if (!raw.compactionId) return { kind: 'compaction', summary: raw.summary };
        if (raw.status === 'failed') {
          return { kind: 'notice', level: 'error', message: raw.error ?? t().stream.compactionFailed };
        }
        if (raw.status === 'cancelled') return null;
        if (this.startedCompactions.has(raw.compactionId)) {
          this.startedCompactions.delete(raw.compactionId);
          return null;
        }
        this.startedCompactions.add(raw.compactionId);
        this.trimSet(this.startedCompactions, MAX_COMPACTIONS);
        return { kind: 'compaction', summary: raw.summary };
      }
      case 'state_update': {
        // Only the idle end-of-turn token usage adds anything the response path
        // does not already deliver; running/requires_action need no visual state
        // and the stop reason is surfaced from the sendMessage response.
        const usage = raw.usage;
        if (raw.state !== 'idle' || !usage) return null;
        return {
          kind: 'usage',
          totalTokens: asNumber(usage.totalTokens),
          inputTokens: asNumber(usage.inputTokens),
          outputTokens: asNumber(usage.outputTokens),
          thoughtTokens: asNumber(usage.thoughtTokens),
          used: asNumber(usage.used),
          size: asNumber(usage.size),
          cost: asCost(usage.cost),
        };
      }
      default:
        return null;
    }
  }
}

const asNumber = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
// state_update.idle carries usage as an opaque record; the cost sub-object is
// the same {amount,currency} shape usage_update validates with zCost.
const asCost = (v: unknown): { amount: number; currency: string } | undefined => {
  if (!v || typeof v !== 'object') return undefined;
  const { amount, currency } = v as { amount?: unknown; currency?: unknown };
  return typeof amount === 'number' && typeof currency === 'string' ? { amount, currency } : undefined;
};
