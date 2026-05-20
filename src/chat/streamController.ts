import type { SessionUpdate, SessionConfigOption, ModeOption, AvailableCommand, ModelOption } from '../types';
import type { ChatState } from './chatState';
import type { ChatRenderer } from '../view/renderer';
import type { SyncEngine } from '../sync/engine';
import type { SyncContext } from '../sync/templates';
import type { SessionStore } from './session';

export interface StreamControllerDeps {
	state: ChatState;
	renderer: ChatRenderer;
	syncEngine: SyncEngine;
	sessionStore: SessionStore;
	getSessionId: () => string | null;
	onConfigUpdate?: (configOptions: SessionConfigOption[]) => void;
	onModeUpdate?: (currentModeId: string | null, availableModes: ModeOption[]) => void;
	onModelsUpdate?: (currentModelId: string | null, availableModels: ModelOption[]) => void;
	onCommandsUpdate?: (commands: AvailableCommand[]) => void;
}

export class StreamController {
	private deps: StreamControllerDeps;
	private syncedToolCalls = new Set<string>();
	private pendingToolInputs = new Map<string, Record<string, unknown>>();
	private pendingToolKinds = new Map<string, string>();
	private assistantMessageIndex = new Map<string, number>();
	private assistantMessageBuffer = new Map<string, string>();
	private saveTimer: number | null = null;

	constructor(deps: StreamControllerDeps) {
		this.deps = deps;
	}

	handleChunk(ch: SessionUpdate): void {
		const { state, renderer } = this.deps;

		switch (ch.sessionUpdate) {
			case 'agent_message_chunk': {
				renderer.removeAssistantPlaceholder();
				const text = (ch as any).content?.text ?? '';
				renderer.appendText(text, ch.messageId);
				this.saveAssistantChunk(ch.messageId, text, 'text');
				break;
			}
			case 'agent_thought_chunk': {
				renderer.removeAssistantPlaceholder();
				const text = (ch as any).content?.text ?? '';
				renderer.appendThinking(text, ch.messageId);
				this.saveAssistantChunk(ch.messageId, text, 'thinking');
				break;
			}
			case 'tool_call': {
				const t = ch as any;
				renderer.addToolCall(t.toolCallId, t.title, t.kind, t.rawInput);
				if (t.rawInput) this.pendingToolInputs.set(t.toolCallId, t.rawInput);
				if (t.kind) this.pendingToolKinds.set(t.toolCallId, t.kind);
				break;
			}
			case 'tool_call_update': {
				const t = ch as any;
				const input = t.rawInput ?? this.pendingToolInputs.get(t.toolCallId);
				const kind = t.kind ?? this.pendingToolKinds.get(t.toolCallId);
				renderer.updateToolCall(t.toolCallId, t.status, t.rawOutput, t.content);

				if ((t.status === 'completed' || t.status === 'failed') && !this.syncedToolCalls.has(t.toolCallId)) {
					this.syncedToolCalls.add(t.toolCallId);
					const contentText = t.content?.[0]?.content?.text ?? '';
					const ctx: SyncContext = {
						toolCallId: t.toolCallId,
						toolName: kind ?? 'unknown',
						toolStatus: t.status,
						rawInput: input,
						rawOutput: t.rawOutput,
						content: contentText,
					};
					this.deps.syncEngine.process(ctx).catch(e => {
						console.error('[copsidian] sync failed:', e);
					});
				}
				break;
			}
			case 'plan': {
				renderer.setPlanEntries((ch as any).entries);
				break;
			}
			case 'config_option_update': {
				const configOpts = (ch as any).configOptions as SessionConfigOption[] | undefined;
				if (configOpts) {
					state.configOptions = configOpts;
					this.deps.onConfigUpdate?.(configOpts);
				}
				break;
			}
			case 'available_commands_update': {
				const cmds = (ch as any).availableCommands as AvailableCommand[] | undefined;
				if (cmds) {
					state.availableCommands = cmds;
					this.deps.onCommandsUpdate?.(cmds);
				}
				break;
			}
			case 'usage_update': {
				const u = ch as any;
				state.usage = {
					totalTokens: u.totalTokens ?? u.used ?? 0,
					inputTokens: u.inputTokens ?? 0,
					outputTokens: u.outputTokens ?? 0,
					thoughtTokens: u.thoughtTokens,
					cost: u.cost,
				};
				break;
			}
			case 'current_mode_update': {
				const m = ch as any;
				const modeId = m.currentModeId as string | undefined;
				const modes = m.availableModes as ModeOption[] | undefined;
				if (modeId !== undefined) state.currentModeId = modeId;
				if (modes) state.availableModes = modes;
				this.deps.onModeUpdate?.(state.currentModeId, state.availableModes);
				break;
			}
			case 'current_model_update': {
				const m = ch as any;
				const modelId = m.currentModelId as string | undefined;
				const models = m.availableModels as ModelOption[] | undefined;
				if (modelId !== undefined) state.currentModelId = modelId;
				if (models) state.availableModels = models;
				this.deps.onModelsUpdate?.(state.currentModelId, state.availableModels);
				break;
			}
			case 'session_info_update': {
				const info = ch as any;
				const sid = info.sessionId ?? this.deps.getSessionId();
				if (sid && info.title) {
					const session = this.deps.sessionStore.get(sid);
					if (session) {
						session.title = info.title;
						this.scheduleSave();
					}
				}
				break;
			}
			case 'user_message_chunk': {
				break;
			}
		}
	}

	reset(): void {
		this.syncedToolCalls.clear();
		this.pendingToolInputs.clear();
		this.pendingToolKinds.clear();
		this.assistantMessageIndex.clear();
		this.assistantMessageBuffer.clear();
		this.deps.state.resetStreamingState();
		if (this.saveTimer !== null) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
	}

	private saveAssistantChunk(messageId: string, chunk: string, type: 'text' | 'thinking'): void {
		const sessionId = this.deps.getSessionId();
		if (!sessionId) return;

		const key = `${sessionId}:${messageId}:${type}`;
		const index = this.assistantMessageIndex.get(key);
		const buffer = (this.assistantMessageBuffer.get(key) ?? '') + chunk;
		this.assistantMessageBuffer.set(key, buffer);

		if (index === undefined) {
			this.deps.sessionStore.getOrCreate(sessionId);
			const session = this.deps.sessionStore.get(sessionId);
			if (!session) return;
			session.messages.push({
				role: 'assistant',
				content: buffer,
				type,
				timestamp: Date.now(),
			});
			this.assistantMessageIndex.set(key, session.messages.length - 1);
			session.updatedAt = Date.now();
		} else {
			const session = this.deps.sessionStore.get(sessionId);
			if (!session) return;
			const msg = session.messages[index];
			if (msg) msg.content = buffer;
			session.updatedAt = Date.now();
		}
		this.deps.sessionStore.setActive(sessionId);
		this.scheduleSave();
	}

	saveMessage(role: 'user' | 'assistant', content: string, type: string): void {
		const sessionId = this.deps.getSessionId();
		if (!sessionId) return;
		this.deps.sessionStore.getOrCreate(sessionId);
		this.deps.sessionStore.append(sessionId, {
			role,
			content,
			type: type as 'text' | 'tool-call' | 'tool-result' | 'thinking',
			timestamp: Date.now(),
		});
		this.deps.sessionStore.setActive(sessionId);
		this.scheduleSave();
	}

	private scheduleSave(): void {
		if (this.saveTimer !== null) clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => this.deps.sessionStore.save(), 500);
	}
}
