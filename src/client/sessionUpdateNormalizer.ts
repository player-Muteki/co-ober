import type { SessionUpdate, NormalizedUpdate, ChunkContent } from '../types';
import { safeClone } from '../utils/clone';

const MAX_ACCUMULATED_MESSAGES = 200;
const MAX_TOOL_CALLS = 100;

export class SessionUpdateNormalizer {
  private readonly accumulatedMessages = new Map<string, { role: 'user' | 'agent' | 'thought'; text: string }>();
  private readonly toolCalls = new Map<string, Extract<NormalizedUpdate, { kind: 'tool_call_snapshot' }>>();

  reset(): void {
    this.accumulatedMessages.clear();
    this.toolCalls.clear();
  }

  /** Evict the oldest entries when the map exceeds the given limit. */
  private trimMap<K, V>(map: Map<K, V>, maxEntries: number): void {
    if (map.size <= maxEntries) return;
    const keysToDelete = [...map.keys()].slice(0, map.size - maxEntries);
    for (const key of keysToDelete) {
      map.delete(key);
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
  private chunkUpdate(role: 'user' | 'agent' | 'thought', messageId: string, content: ChunkContent): NormalizedUpdate {
    const text = content.type === 'text' ? content.text ?? '' : '';
    const existing = this.accumulatedMessages.get(messageId);
    const accumulatedText = existing ? existing.text + text : text;
    this.accumulatedMessages.set(messageId, { role, text: accumulatedText });
    this.trimMap(this.accumulatedMessages, MAX_ACCUMULATED_MESSAGES);
    const update: Extract<NormalizedUpdate, { kind: 'message_chunk' }> = {
      kind: 'message_chunk',
      role,
      messageId,
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
          toolKind: raw.kind ?? 'other',
          status: (raw.status as 'pending' | 'in_progress' | 'completed' | 'failed') ?? 'pending',
          rawInput: raw.rawInput,
          locations: raw.locations,
          contents: [],
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
            toolKind: raw.kind ?? 'other',
            status: (raw.status as 'pending' | 'in_progress' | 'completed' | 'failed') ?? 'completed',
            contents: raw.content ? [...raw.content] : [],
          };
          this.toolCalls.set(raw.toolCallId, existing);
          this.trimMap(this.toolCalls, MAX_TOOL_CALLS);
        } else if (raw.content) {
          existing.contents = existing.contents.concat(raw.content);
        }

        if (raw.status) existing.status = raw.status;
        if (raw.title) existing.title = raw.title;
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
      default:
        return null;
    }
  }
}
