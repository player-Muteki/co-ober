import type { NormalizedUpdate, SessionConfigOption, ModeOption, AvailableCommand, ModelOption, ToolCallContent, ToolKind } from '../types';
import type { ChatState } from './chatState';
import type { ChatRenderer } from '../view/renderer';
import type { SyncEngine } from '../sync/engine';
import type { SyncContext } from '../sync/templates';
import type { SessionStore } from './session';
import { t } from '../i18n/index';

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
	onUsageUpdate?: () => void;
	onSyncFailure?: (message: string) => void;
}

export class StreamController {
	private deps: StreamControllerDeps;
	private syncedToolCalls = new Set<string>();
	private assistantMessageIndex = new Map<string, number>();
	private saveTimer: number | null = null;
	private disposed = false;

	// Phase 4 — tool call buffering
	private pendingToolBuffer: Array<{
		toolCallId: string;
		title: string;
		toolKind: ToolKind;
		status: 'pending' | 'in_progress' | 'completed' | 'failed';
		rawInput?: Record<string, unknown>;
		rawOutput?: Record<string, unknown>;
		locations?: { path: string }[];
		contents: ToolCallContent[];
	}> = [];

	constructor(deps: StreamControllerDeps) {
		this.deps = deps;
	}

	dispose(): void {
		this.disposed = true;
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
	}

	handleChunk(ch: NormalizedUpdate): void {
		const { state, renderer } = this.deps;

		// Flush any buffered pending tool calls before handling non-tool events,
		// to keep tool calls from interleaving mid-stream.
		if (ch.kind !== 'tool_call_snapshot' || (ch.status !== 'pending' && ch.status !== 'in_progress')) {
			this.flushToolBuffer();
		}

		switch (ch.kind) {
			case 'message_chunk': {
				if (ch.role === 'user') break;
				renderer.removeAssistantPlaceholder();
				if (ch.role === 'agent') {
					// Flush thinking render before switching to text content
					renderer.flushThinkingRender().catch(() => {});
					renderer.appendText(ch.chunkText, ch.messageId);
					this.saveAssistantChunk(ch.messageId, ch.accumulatedText, 'text');
				} else if (ch.role === 'thought') {
					// Flush text render before switching to thinking content
					renderer.flushTextRender().catch(() => {});
					renderer.appendThinking(ch.chunkText, ch.messageId);
					this.saveAssistantChunk(ch.messageId, ch.accumulatedText, 'thinking');
				}
				break;
			}
			case 'tool_call_snapshot': {
				if (ch.status === 'pending' || ch.status === 'in_progress') {
					// Buffer pending/in_progress tool calls to prevent
					// interleaving mid-response during streaming.
					this.pendingToolBuffer.push({ ...ch });
				} else {
					// Flush any buffered pending tools, then update completed/failed
					this.flushToolBuffer();
					renderer.updateToolCall(ch.toolCallId, ch.status, ch.rawOutput, ch.contents, ch.rawInput, ch.locations, ch.toolKind);
				}

				if ((ch.status === 'completed' || ch.status === 'failed') && !this.syncedToolCalls.has(ch.toolCallId)) {
					this.syncedToolCalls.add(ch.toolCallId);
					const firstContent = ch.contents?.[0];
					const contentText = firstContent?.type === 'content' && firstContent.content?.type === 'text' ? firstContent.content.text : '';
					const ctx: SyncContext = {
						toolCallId: ch.toolCallId,
						toolName: ch.toolKind,
						toolStatus: ch.status,
						rawInput: ch.rawInput,
						rawOutput: ch.rawOutput,
						content: contentText,
					};
					this.deps.syncEngine.process(ctx).then((failures) => {
						if (this.disposed) return;
						for (const failure of failures) {
							this.deps.onSyncFailure?.(t().sync.ruleFailed
								.replace('{rule}', failure.rule.toolName)
								.replace('{error}', failure.error.message));
						}
					}).catch(e => {
						if (this.disposed) return;
						console.error('[co-ober] sync failed:', e);
						this.deps.onSyncFailure?.(e instanceof Error ? e.message : String(e));
					});
				}
				break;
			}
			case 'plan': {
				renderer.setPlanEntries(ch.entries);
				break;
			}
			case 'config_options': {
				state.configOptions = ch.configOptions;
				this.deps.onConfigUpdate?.(ch.configOptions);
				break;
			}
			case 'commands': {
				state.availableCommands = ch.commands;
				this.deps.onCommandsUpdate?.(ch.commands);
				break;
			}
		case 'usage': {
				if (state.usage) {
					if (ch.cost) state.usage.cost = ch.cost;
					if (ch.size) state.usage.contextWindow = ch.size;
					if (ch.used) state.usage.contextTokens = ch.used;
				} else {
					state.usage = {
						totalTokens: ch.totalTokens ?? ch.used ?? 0,
						inputTokens: ch.inputTokens ?? 0,
						outputTokens: ch.outputTokens ?? 0,
						thoughtTokens: ch.thoughtTokens,
						cost: ch.cost,
						contextWindow: ch.size,
						contextTokens: ch.used,
					};
				}
				this.deps.onUsageUpdate?.();
				break;
			}
			case 'mode': {
				if (ch.currentModeId !== null) state.currentModeId = ch.currentModeId;
				if (ch.availableModes) state.availableModes = ch.availableModes;
				this.deps.onModeUpdate?.(state.currentModeId, state.availableModes);
				break;
			}
			case 'model': {
				if (ch.currentModelId !== null) state.currentModelId = ch.currentModelId;
				if (ch.availableModels) state.availableModels = ch.availableModels;
				this.deps.onModelsUpdate?.(state.currentModelId, state.availableModels);
				break;
			}
			case 'session_info': {
				const sid = ch.sessionId ?? this.deps.getSessionId();
				if (sid && ch.title) {
					const session = this.deps.sessionStore.get(sid);
					if (session) {
						session.title = ch.title;
						this.scheduleSave();
					}
				}
				break;
			}
		}
	}

	reset(): void {
		this.syncedToolCalls.clear();
		this.assistantMessageIndex.clear();
		this.pendingToolBuffer = [];
		this.deps.state.resetStreamingState();
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
	}

	/**
	 * Flush buffered pending tool calls to the renderer.
	 * Called before handling any non-pending event so tool calls
	 * appear in sequence rather than interleaved mid-stream.
	 */
	private flushToolBuffer(): void {
		if (this.pendingToolBuffer.length === 0) return;
		const { renderer } = this.deps;
		for (const tc of this.pendingToolBuffer) {
			renderer.addToolCall(tc.toolCallId, tc.title, tc.toolKind, tc.rawInput, tc.locations);
		}
		this.pendingToolBuffer = [];
	}

	private saveAssistantChunk(messageId: string, accumulatedText: string, type: 'text' | 'thinking'): void {
		const sessionId = this.deps.getSessionId();
		if (!sessionId) return;

		const key = `${sessionId}:${messageId}:${type}`;
		const index = this.assistantMessageIndex.get(key);

		if (index === undefined) {
			this.deps.sessionStore.getOrCreate(sessionId);
			const session = this.deps.sessionStore.get(sessionId);
			if (!session) return;
			session.messages.push({
				role: 'assistant',
				content: accumulatedText,
				type,
				timestamp: Date.now(),
			});
			this.assistantMessageIndex.set(key, session.messages.length - 1);
			session.updatedAt = Date.now();
		} else {
			const session = this.deps.sessionStore.get(sessionId);
			if (!session) return;
			const msg = session.messages[index];
			if (msg) msg.content = accumulatedText;
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
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => { void this.deps.sessionStore.save(); }, 500);
	}
}
