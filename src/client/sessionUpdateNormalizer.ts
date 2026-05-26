import type { SessionUpdate, NormalizedUpdate } from '../types';

export class SessionUpdateNormalizer {
  private readonly accumulatedMessages = new Map<string, { role: 'user' | 'agent' | 'thought'; text: string }>();
  private readonly toolCalls = new Map<string, Extract<NormalizedUpdate, { kind: 'tool_call_snapshot' }>>();

  reset(): void {
    this.accumulatedMessages.clear();
    this.toolCalls.clear();
  }

  normalize(raw: SessionUpdate): NormalizedUpdate | null {
    switch (raw.sessionUpdate) {
      case 'user_message_chunk': {
        const text = raw.content.text;
        const existing = this.accumulatedMessages.get(raw.messageId);
        const accumulatedText = existing ? existing.text + text : text;
        this.accumulatedMessages.set(raw.messageId, { role: 'user', text: accumulatedText });
        return { kind: 'message_chunk', role: 'user', messageId: raw.messageId, chunkText: text, accumulatedText };
      }
      case 'agent_message_chunk': {
        const text = raw.content.text;
        const existing = this.accumulatedMessages.get(raw.messageId);
        const accumulatedText = existing ? existing.text + text : text;
        this.accumulatedMessages.set(raw.messageId, { role: 'agent', text: accumulatedText });
        return { kind: 'message_chunk', role: 'agent', messageId: raw.messageId, chunkText: text, accumulatedText };
      }
      case 'agent_thought_chunk': {
        const text = raw.content.text;
        const existing = this.accumulatedMessages.get(raw.messageId);
        const accumulatedText = existing ? existing.text + text : text;
        this.accumulatedMessages.set(raw.messageId, { role: 'thought', text: accumulatedText });
        return { kind: 'message_chunk', role: 'thought', messageId: raw.messageId, chunkText: text, accumulatedText };
      }
      case 'tool_call': {
        const snapshot: Extract<NormalizedUpdate, { kind: 'tool_call_snapshot' }> = {
          kind: 'tool_call_snapshot',
          toolCallId: raw.toolCallId,
          title: raw.title,
          toolKind: raw.kind ?? 'other',
          status: (raw.status as any) ?? 'pending',
          rawInput: raw.rawInput,
          locations: raw.locations,
          contents: [],
        };
        this.toolCalls.set(raw.toolCallId, snapshot);
        return { ...snapshot, contents: [...snapshot.contents] }; // return copy to prevent outside mutation
      }
      case 'tool_call_update': {
        const existing = this.toolCalls.get(raw.toolCallId);
        if (!existing) return null; // should not happen if tool_call was received

        if (raw.status) existing.status = raw.status;
        if (raw.title) existing.title = raw.title;
        if (raw.kind) existing.toolKind = raw.kind;
        if (raw.rawInput) existing.rawInput = { ...existing.rawInput, ...raw.rawInput };
        if (raw.rawOutput) existing.rawOutput = { ...existing.rawOutput, ...raw.rawOutput };
        if (raw.locations) existing.locations = raw.locations;
        if (raw.content) {
          existing.contents = existing.contents.concat(raw.content);
        }

        return { ...existing, contents: [...existing.contents] };
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
