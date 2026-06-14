import type { SerializedMessage, SessionConfigOption, AvailableCommand, UsageInfo } from '../types';

export interface PendingToolCall {
	toolCallId: string;
	title: string;
	kind: string;
	status: string;
}

export interface ThinkingState {
	content: string;
	collapsed: boolean;
}

export class ChatState {
	// Session
	sessionId: string | null = null;
	isConnected = false;

	// Messages
	messages: SerializedMessage[] = [];

	// Streaming
	isStreaming = false;
	currentMessageId: string | null = null;
	currentTextContent = '';
	currentThinking: ThinkingState | null = null;
	pendingTools = new Map<string, PendingToolCall>();

	// Usage
	usage: UsageInfo | null = null;

	// Config (from ACP session)
	configOptions: SessionConfigOption[] = [];
	availableCommands: AvailableCommand[] = [];
	availableModels: Array<{ modelId: string; name: string }> = [];
	currentModelId: string | null = null;
	currentModeId: string | null = null;
	availableModes: Array<{ id: string; name: string; description?: string }> = [];

	// Auto-scroll
	autoScrollEnabled = true;

	// Attention
	needsAttention = false;

	// Error
	lastError: string | null = null;

	addMessage(msg: SerializedMessage): void {
		this.messages.push(msg);
	}

	resetStreamingState(): void {
		this.currentTextContent = '';
		this.currentThinking = null;
		this.pendingTools.clear();
		this.isStreaming = false;
		this.currentMessageId = null;
	}

	clear(): void {
		this.messages = [];
		this.usage = null;
		this.configOptions = [];
		this.availableCommands = [];
		this.availableModels = [];
		this.currentModelId = null;
		this.currentModeId = null;
		this.availableModes = [];
		this.lastError = null;
		this.needsAttention = false;
		this.resetStreamingState();
	}
}
