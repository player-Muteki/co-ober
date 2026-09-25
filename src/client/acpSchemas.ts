import { z } from 'zod';

const zToolKind = z.enum(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other']);
const zToolCallContent = z.union([
  z.object({ type: z.literal('content'), content: z.object({ type: z.literal('text'), text: z.string() }) }),
  z.object({ type: z.literal('content'), content: z.object({ type: z.literal('image'), mimeType: z.string(), data: z.string() }) }),
  z.object({ type: z.literal('diff'), path: z.string(), oldText: z.string().optional(), newText: z.string().optional() }),
  z.object({ type: z.literal('terminal'), terminalId: z.string() }),
]);
const zLocation = z.object({ path: z.string() });
const zConfigOption = z.object({
  id: z.enum(['model', 'effort', 'mode']),
  name: z.string(),
  category: z.enum(['model', 'thought_level', 'mode']),
  type: z.literal('select'),
  currentValue: z.string(),
  options: z.array(z.object({ value: z.string(), name: z.string(), description: z.string().optional() })),
});
const zModeOption = z.object({ id: z.string(), name: z.string(), description: z.string().optional() });
const zModelOption = z.object({ modelId: z.string(), name: z.string() });
const zAvailableCommand = z.object({ name: z.string(), description: z.string() });
const zCost = z.object({ amount: z.number(), currency: z.string() });
// Chunk content is deliberately permissive: text is the only shape the
// transcript accumulates, but image/audio/resource payloads must parse so a
// non-text frame is visible downstream instead of being dropped at the gate.
const zChunkContent = z.object({
  type: z.string(),
  text: z.string().optional(),
  mimeType: z.string().optional(),
  data: z.string().optional(),
});
// A plan entry with an unexpected status/priority value must not cost us the
// whole plan; fall back to neutral defaults.
const zEntry = z.object({
  content: z.string().catch(''),
  status: z.string().catch('pending'),
  priority: z.string().catch('medium'),
});

export const zAgentMessageChunk = z.object({
  sessionUpdate: z.literal('agent_message_chunk'),
  messageId: z.string(),
  content: zChunkContent,
});
export const zAgentThoughtChunk = z.object({
  sessionUpdate: z.literal('agent_thought_chunk'),
  messageId: z.string(),
  content: zChunkContent,
});
export const zUserMessageChunk = z.object({
  sessionUpdate: z.literal('user_message_chunk'),
  messageId: z.string(),
  content: zChunkContent,
});
export const zToolCall = z.object({
  sessionUpdate: z.literal('tool_call'),
  toolCallId: z.string(),
  title: z.string(),
  // Stable since schema v1.23.0: the programmatic tool name, orthogonal to
  // the human-readable title. null and omission both mean "no name".
  name: z.string().nullish().transform((n) => n ?? undefined),
  kind: zToolKind.optional(),
  status: z.string().optional(),
  rawInput: z.record(z.string(), z.unknown()).optional(),
  locations: z.array(zLocation).optional(),
  content: z.array(zToolCallContent).optional(),
});
export const zToolCallUpdate = z.object({
  sessionUpdate: z.literal('tool_call_update'),
  toolCallId: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']),
  kind: zToolKind.optional(),
  title: z.string().optional(),
  name: z.string().nullish().transform((n) => n ?? undefined),
  rawInput: z.record(z.string(), z.unknown()).optional(),
  rawOutput: z.record(z.string(), z.unknown()).optional(),
  content: z.array(zToolCallContent).optional(),
  locations: z.array(zLocation).optional(),
});
export const zPlan = z.object({
  sessionUpdate: z.literal('plan'),
  entries: z.array(zEntry),
});
// ACP v2 replaces the flattened `plan` with an item-based `plan_update` whose
// content is a tagged union (`items` today; other variants are reserved for
// future ACP and must be ignored, not fail the frame). Only `items` renders.
export const zPlanUpdate = z.object({
  sessionUpdate: z.literal('plan_update'),
  plan: z.object({
    type: z.string(),
    id: z.string().optional(),
    planId: z.string().optional(),
    entries: z.array(zEntry).optional(),
  }),
});
export const zConfigOptionUpdate = z.object({
  sessionUpdate: z.literal('config_option_update'),
  configOptions: z.array(zConfigOption),
});
export const zAvailableCommandsUpdate = z.object({
  sessionUpdate: z.literal('available_commands_update'),
  availableCommands: z.array(zAvailableCommand),
});
export const zCurrentModeUpdate = z.object({
  sessionUpdate: z.literal('current_mode_update'),
  currentModeId: z.string().optional(),
  availableModes: z.array(zModeOption).optional(),
});
export const zCurrentModelUpdate = z.object({
  sessionUpdate: z.literal('current_model_update'),
  currentModelId: z.string().optional(),
  availableModels: z.array(zModelOption).optional(),
});
export const zSessionInfoUpdate = z.object({
  sessionUpdate: z.literal('session_info_update'),
  sessionId: z.string().optional(),
  title: z.string().optional(),
  cwd: z.string().optional(),
  // v2-alpha folds config option delivery into session info. A shape we do
  // not understand must not cost us the title update, so drop it silently.
  configOptions: z.array(zConfigOption).optional().catch(undefined),
});
export const zUsageUpdate = z.object({
  sessionUpdate: z.literal('usage_update'),
  used: z.number().optional(),
  size: z.number().optional(),
  totalTokens: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  thoughtTokens: z.number().optional(),
  cost: zCost.optional(),
});
// `notice` and `compaction` updates are agent-side extensions (ACP RFDs
// #2004/#2002) that are not in the v1 contract yet. Agents already emit
// them; parse a permissive shape so they render instead of dropping, and
// never let a malformed field cost us the frame.
export const zNoticeUpdate = z.object({
  sessionUpdate: z.literal('notice_update'),
  level: z.string().catch('info'),
  message: z.preprocess((v) => (typeof v === 'string' ? v : typeof (v as { text?: unknown })?.text === 'string' ? (v as { text: string }).text : ''), z.string().catch('')),
});
// Official v2-alpha notice frame (feature unstable_session_notices):
// `notice{severity,title,description}`. Coerced onto the internal shape.
export const zNotice = z.object({
  sessionUpdate: z.literal('notice'),
  severity: z.string().catch('info'),
  title: z.string().catch(''),
  description: z.string().optional(),
});
// v1-era RFD shape (summary is a plain string) and the official v2-alpha
// shape (compactionId + status + ContentBlock[] summary) share this frame
// name; accept both. The summary is flattened to text here because the
// transcript only paints the boundary marker.
const flattenSummary = (v: unknown): string | undefined => {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    const text = v
      .map((b) => ((b as { type?: string; text?: unknown })?.type === 'text' ? String((b as { text: unknown }).text ?? '') : ''))
      .filter(Boolean)
      .join('\n');
    return text || undefined;
  }
  return undefined;
};
export const zCompactionUpdate = z.object({
  sessionUpdate: z.literal('compaction_update'),
  compactionId: z.string().optional(),
  status: z.string().optional(),
  summary: z.preprocess(flattenSummary, z.string().optional().catch(undefined)),
  error: z.string().optional(),
});
export const zCompactionSummaryChunk = z.object({
  sessionUpdate: z.literal('compaction_summary_chunk'),
  compactionId: z.string(),
  content: zChunkContent,
});
// v2-alpha turn-lifecycle frame: running/idle/requires_action, with the idle
// transition optionally carrying the end-turn stop reason and token usage.
export const zStateUpdate = z.object({
  sessionUpdate: z.literal('state_update'),
  state: z.string(),
  stopReason: z.string().nullish().transform((s) => s ?? undefined),
  usage: z.record(z.string(), z.unknown()).optional(),
});

export const zSessionUpdate = z.discriminatedUnion('sessionUpdate', [
  zAgentMessageChunk,
  zAgentThoughtChunk,
  zUserMessageChunk,
  zToolCall,
  zToolCallUpdate,
  zPlan,
  zPlanUpdate,
  zConfigOptionUpdate,
  zAvailableCommandsUpdate,
  zCurrentModeUpdate,
  zCurrentModelUpdate,
  zSessionInfoUpdate,
  zUsageUpdate,
  zNoticeUpdate,
  zNotice,
  zCompactionUpdate,
  zCompactionSummaryChunk,
  zStateUpdate,
]);
