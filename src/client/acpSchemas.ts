import { z } from 'zod';

// Mirrors ToolKind in types.ts; agents assign 'apply_patch' to patch edits,
// and a kind missing from this enum would cost the whole frame or permission
// request. Extend both lists together.
export const zToolKind = z.enum(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'apply_patch', 'other']);
// Agents mint tool kinds ahead of the enum; an unknown kind must degrade to
// 'other', not cost us the whole tool frame.
export const zToolKindLenient = zToolKind.catch('other');
// Agents send explicit nulls where `.optional()` only forgives omission;
// a null on a peripheral field must degrade to absent, not cost the frame.
const zOpt = <T extends z.ZodTypeAny>(schema: T) => schema.nullish().transform((v) => v ?? undefined);
// rawInput/rawOutput carry no type at all in ACP — any JSON is a legal payload.
// Requiring an object cost the whole frame (and on a permission request it also
// cancelled the prompt the user never saw), so anything that is not an object
// is kept under `value`: the card can still print what the agent sent.
export const zRawJson = z
  .unknown()
  .nullish()
  .transform((value): Record<string, unknown> | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    return { value };
  });
// A content element we cannot render (resource_link, malformed terminal…)
// must not drop the whole tool frame, and must not vanish from it either: it
// keeps its wire tag as `unsupported` so the card can say what it could not
// show instead of degrading it into an empty text item nobody can see.
const zUnsupportedContent = z
  .object({ type: z.string().catch('') })
  .transform((item) => ({ type: 'unsupported' as const, originalType: item.type }));
const zToolCallContent = z
  .union([
    z.object({ type: z.literal('content'), content: z.object({ type: z.literal('text'), text: z.string() }) }),
    z.object({ type: z.literal('content'), content: z.object({ type: z.literal('image'), mimeType: z.string(), data: z.string() }) }),
    z.object({ type: z.literal('diff'), path: z.string(), oldText: z.string().optional(), newText: z.string().optional() }),
    z.object({ type: z.literal('terminal'), terminalId: z.string() }),
    zUnsupportedContent,
  ])
  .catch({ type: 'unsupported' as const, originalType: '' });
const zLocation = z.object({ path: z.string() });
const zConfigSelectOption = z.object({
  value: z.string(),
  name: z.string(),
  description: z.string().optional(),
});
const zConfigSelectGroup = z.object({
  group: z.string(),
  name: z.string(),
  options: z.array(z.unknown()),
});
// `SessionConfigSelectOptions` is a union: a flat list of values, or a list of
// groups whose headers are not themselves selectable. Reading only the first
// member of that union cost every grouped agent its whole dropdown — each
// element failed the value check, the array was caught to [] and the model,
// mode and effort selectors rendered empty. Flatten the groups, carrying the
// group name into the option's description so the header still reads as the
// thing it is.
const flattenConfigOptions = (items: unknown[]): z.infer<typeof zConfigSelectOption>[] => {
  const readable: z.infer<typeof zConfigSelectOption>[] = [];
  for (const item of items) {
    const flat = zConfigSelectOption.safeParse(item);
    if (flat.success) {
      readable.push(flat.data);
      continue;
    }
    const group = zConfigSelectGroup.safeParse(item);
    if (!group.success) continue;
    for (const child of group.data.options) {
      const option = zConfigSelectOption.safeParse(child);
      if (!option.success) continue;
      const { description, ...rest } = option.data;
      readable.push({
        ...rest,
        description: description ? `${group.data.name} · ${description}` : group.data.name,
      });
    }
  }
  return readable;
};
// Agents define config options beyond the three we render (and grow them
// ahead of the spec); the rigid id/category/type enums once cost us the whole
// config_option_update frame — including the model list — because one unknown
// option rode along. Consumers look options up by id and ignore the rest.
const zConfigOption = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string().optional(),
  type: z.string(),
  // SessionConfigBoolean carries a real boolean here, and a select carries a
  // value id. Reading both as a string turned every toggle's state into ''.
  currentValue: z.union([z.string(), z.boolean()]).catch(''),
  // Boolean-toggle options legitimately carry no choices; a missing or
  // malformed options array must not drop the whole config frame.
  options: z.array(z.unknown()).transform(flattenConfigOptions).catch([]),
});
// One option this client cannot read — an id-less or type-less entry, or
// something that is not an object at all — may only remove itself. Parsing the
// array element by element is what keeps that option from taking the model
// list, the mode list and the effort selector with it.
const zConfigOptions = z.array(z.unknown()).transform((items) => {
  const readable: z.infer<typeof zConfigOption>[] = [];
  for (const item of items) {
    const parsed = zConfigOption.safeParse(item);
    if (parsed.success) readable.push(parsed.data);
  }
  return readable;
});
const zModeOption = z.object({ id: z.string(), name: z.string(), description: zOpt(z.string()) });
const zModelOption = z.object({ modelId: z.string(), name: z.string() });
// ACP carries the expected-argument hint in `input.hint`; dropping it here is
// what made agent commands render bare in the slash menu.
const zAvailableCommand = z.object({
  name: z.string(),
  description: z.string(),
  input: z.object({ hint: z.string().optional() }).nullish(),
});
// Same rule as one unreadable config option: a command this client cannot
// parse may remove only itself. Without the element-by-element pass a single
// malformed entry still cleared the whole slash menu for the tab.
const zAvailableCommands = z.array(z.unknown()).transform((items) => {
  const readable: z.infer<typeof zAvailableCommand>[] = [];
  for (const item of items) {
    const parsed = zAvailableCommand.safeParse(item);
    if (parsed.success) readable.push(parsed.data);
  }
  return readable;
});
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

// `messageId` is optional and unstable in the SDK (only `content` is
// required), so a chunk that carries no id is a frame the protocol allows. It
// must reach the transcript; the normalizer gives it a stable id for its run.
const zChunkMessageId = z.string().nullish().transform((id) => id ?? undefined);
export const zAgentMessageChunk = z.object({
  sessionUpdate: z.literal('agent_message_chunk'),
  messageId: zChunkMessageId,
  content: zChunkContent,
});
export const zAgentThoughtChunk = z.object({
  sessionUpdate: z.literal('agent_thought_chunk'),
  messageId: zChunkMessageId,
  content: zChunkContent,
});
export const zUserMessageChunk = z.object({
  sessionUpdate: z.literal('user_message_chunk'),
  messageId: zChunkMessageId,
  content: zChunkContent,
});
export const zToolCall = z.object({
  sessionUpdate: z.literal('tool_call'),
  toolCallId: z.string(),
  title: z.string(),
  // Stable since schema v1.23.0: the programmatic tool name, orthogonal to
  // the human-readable title. null and omission both mean "no name".
  name: z.string().nullish().transform((n) => n ?? undefined),
  kind: zToolKindLenient.optional(),
  status: zOpt(z.string()),
  rawInput: zRawJson,
  // An agent that answers a tool call in one frame — output and all — is
  // within the spec; only accepting rawOutput on the update frame threw the
  // first frame's result away, leaving the card forever without an output.
  rawOutput: zRawJson,
  locations: zOpt(z.array(zLocation)),
  content: zOpt(z.array(zToolCallContent)),
});
export const zToolCallUpdate = z.object({
  sessionUpdate: z.literal('tool_call_update'),
  toolCallId: z.string(),
  // A patch frame may omit status or carry one outside the four we render
  // (agents mint 'cancelled' before the enum catches up). Be as permissive as
  // zToolCall's status: never let a terminal-looking patch drop.
  status: zOpt(z.string()),
  kind: zToolKindLenient.optional(),
  // title is ["string","null"] on the wire: an agent clearing a title with an
  // explicit null is within spec, and must not cost the update frame.
  title: zOpt(z.string()),
  name: z.string().nullish().transform((n) => n ?? undefined),
  rawInput: zRawJson,
  rawOutput: zRawJson,
  content: zOpt(z.array(zToolCallContent)),
  locations: zOpt(z.array(zLocation)),
});
export const zPlan = z.object({
  sessionUpdate: z.literal('plan'),
  entries: z.array(zEntry),
});
// Official v2 retires the flattened `plan` for an item-based `plan_update`
// whose content is a tagged union (`items` today; `file`/markdown variants are
// reserved for future ACP and must be ignored, not fail the frame). Only
// `items` renders. `plan_removed` is its counterpart: an empty-plan signal.
export const zPlanUpdate = z.object({
  sessionUpdate: z.literal('plan_update'),
  plan: z.object({
    type: z.string(),
    id: z.string().optional(),
    planId: z.string().optional(),
    entries: z.array(zEntry).optional(),
  }),
});
export const zPlanRemoved = z.object({
  sessionUpdate: z.literal('plan_removed'),
});
export const zConfigOptionUpdate = z.object({
  sessionUpdate: z.literal('config_option_update'),
  configOptions: zConfigOptions,
});
export const zAvailableCommandsUpdate = z.object({
  sessionUpdate: z.literal('available_commands_update'),
  availableCommands: zAvailableCommands,
});
export const zCurrentModeUpdate = z.object({
  sessionUpdate: z.literal('current_mode_update'),
  currentModeId: z.string().optional(),
  availableModes: zOpt(z.array(zModeOption)),
});
export const zCurrentModelUpdate = z.object({
  sessionUpdate: z.literal('current_model_update'),
  currentModelId: z.string().optional(),
  availableModels: zOpt(z.array(zModelOption)),
});
export const zSessionInfoUpdate = z.object({
  sessionUpdate: z.literal('session_info_update'),
  sessionId: z.string().optional(),
  // Both nullable on the wire; an agent that clears the title with null still
  // means the update to say so.
  title: zOpt(z.string()),
  cwd: z.string().optional(),
  // v2-alpha folds config option delivery into session info. A shape we do
  // not understand must not cost us the title update, so drop it silently.
  configOptions: zConfigOptions.optional().catch(undefined),
});
export const zUsageUpdate = z.object({
  sessionUpdate: z.literal('usage_update'),
  used: z.number().optional(),
  size: z.number().optional(),
  totalTokens: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  thoughtTokens: z.number().optional(),
  cost: zOpt(zCost),
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
  usage: zOpt(z.record(z.string(), z.unknown())),
});

export const zSessionUpdate = z.discriminatedUnion('sessionUpdate', [
  zAgentMessageChunk,
  zAgentThoughtChunk,
  zUserMessageChunk,
  zToolCall,
  zToolCallUpdate,
  zPlan,
  zPlanUpdate,
  zPlanRemoved,
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
