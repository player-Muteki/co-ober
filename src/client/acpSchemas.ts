import { z } from 'zod';

const zToolKind = z.enum(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other']);
const zToolCallContent = z.union([
  z.object({ type: z.literal('content'), content: z.object({ type: z.literal('text'), text: z.string() }) }),
  z.object({ type: z.literal('content'), content: z.object({ type: z.literal('image'), mimeType: z.string(), data: z.string() }) }),
  z.object({ type: z.literal('diff'), path: z.string(), oldText: z.string(), newText: z.string() }),
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
const zEntry = z.object({ content: z.string(), status: z.string(), priority: z.string() });

export const zAgentMessageChunk = z.object({
  sessionUpdate: z.literal('agent_message_chunk'),
  messageId: z.string(),
  content: z.object({ type: z.string(), text: z.string() }),
});
export const zAgentThoughtChunk = z.object({
  sessionUpdate: z.literal('agent_thought_chunk'),
  messageId: z.string(),
  content: z.object({ type: z.string(), text: z.string() }),
});
export const zUserMessageChunk = z.object({
  sessionUpdate: z.literal('user_message_chunk'),
  messageId: z.string(),
  content: z.object({ type: z.string(), text: z.string() }),
});
export const zToolCall = z.object({
  sessionUpdate: z.literal('tool_call'),
  toolCallId: z.string(),
  title: z.string(),
  kind: zToolKind.optional(),
  status: z.string().optional(),
  rawInput: z.record(z.string(), z.unknown()).optional(),
  locations: z.array(zLocation).optional(),
});
export const zToolCallUpdate = z.object({
  sessionUpdate: z.literal('tool_call_update'),
  toolCallId: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']),
  kind: zToolKind.optional(),
  title: z.string().optional(),
  rawInput: z.record(z.string(), z.unknown()).optional(),
  rawOutput: z.record(z.string(), z.unknown()).optional(),
  content: z.array(zToolCallContent).optional(),
  locations: z.array(zLocation).optional(),
});
export const zPlan = z.object({
  sessionUpdate: z.literal('plan'),
  entries: z.array(zEntry),
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

export const zSessionUpdate = z.discriminatedUnion('sessionUpdate', [
  zAgentMessageChunk,
  zAgentThoughtChunk,
  zUserMessageChunk,
  zToolCall,
  zToolCallUpdate,
  zPlan,
  zConfigOptionUpdate,
  zAvailableCommandsUpdate,
  zCurrentModeUpdate,
  zCurrentModelUpdate,
  zSessionInfoUpdate,
  zUsageUpdate,
]);
