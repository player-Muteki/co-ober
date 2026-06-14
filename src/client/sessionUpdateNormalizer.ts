import type { SessionUpdate, NormalizedUpdate } from '../types';
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

  normalize(raw: SessionUpdate): NormalizedUpdate | null {
    switch (raw.sessionUpdate) {
      case 'user_message_chunk': {
        const text = raw.content.text;
        const existing = this.accumulatedMessages.get(raw.messageId);
        const accumulatedText = existing ? existing.text + text : text;
        this.accumulatedMessages.set(raw.messageId, { role: 'user', text: accumulatedText });
        this.trimMap(this.accumulatedMessages, MAX_ACCUMULATED_MESSAGES);
        return { kind: 'message_chunk', role: 'user', messageId: raw.messageId, chunkText: text, accumulatedText };
      }
      case 'agent_message_chunk': {
        const text = raw.content.text;
        const existing = this.accumulatedMessages.get(raw.messageId);
        const accumulatedText = existing ? existing.text + text : text;
        this.accumulatedMessages.set(raw.messageId, { role: 'agent', text: accumulatedText });
        this.trimMap(this.accumulatedMessages, MAX_ACCUMULATED_MESSAGES);
        return { kind: 'message_chunk', role: 'agent', messageId: raw.messageId, chunkText: text, accumulatedText };
      }
      case 'agent_thought_chunk': {
        const text = raw.content.text;
        const existing = this.accumulatedMessages.get(raw.messageId);
        const accumulatedText = existing ? existing.text + text : text;
        this.accumulatedMessages.set(raw.messageId, { role: 'thought', text: accumulatedText });
        this.trimMap(this.accumulatedMessages, MAX_ACCUMULATED_MESSAGES);
        return { kind: 'message_chunk', role: 'thought', messageId: raw.messageId, chunkText: text, accumulatedText };
      }
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
        const existing = this.toolCalls.get(raw.toolCallId);
        if (!existing) return null;

        if (raw.status) existing.status = raw.status;
        if (raw.title) existing.title = raw.title;
        if (raw.kind) existing.toolKind = raw.kind;
        if (raw.rawInput) existing.rawInput = { ...existing.rawInput, ...raw.rawInput };
        if (raw.rawOutput) existing.rawOutput = { ...existing.rawOutput, ...raw.rawOutput };
        if (raw.locations) existing.locations = raw.locations;
        if (raw.content) {
          existing.contents = existing.contents.concat(raw.content);
        }

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
        return { kind: 'model', currentModelId: raw.currentModelId ?? null, availableModels: raw.availableModels ?? [] };
      case 'session_info_update':
        return { kind: 'session_info', sessionId: raw.sessionId, title: raw.title, cwd: raw.cwd };
      case 'usage_update':
        return { kind: 'usage', totalTokens: raw.totalTokens, inputTokens: raw.inputTokens, outputTokens: raw.outputTokens, thoughtTokens: raw.thoughtTokens, cost: raw.cost, used: raw.used, size: raw.size };
      default:
        return null;
    }
  }
}
