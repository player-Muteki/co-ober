import type { SessionConfigOption, AvailableCommand, UsageInfo } from '../types';

export class ChatState {
	// Session
	sessionId: string | null = null;
	isConnected = false;

	// Streaming
	isStreaming = false;

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

	// Timestamp of the last streamed plan update; used to suppress a
	// post-turn native plan refresh that would overwrite newer in-flight data.
	lastPlanUpdateAt: number | null = null;

	resetStreamingState(): void {
		this.isStreaming = false;
	}

	clear(): void {
		this.usage = null;
		this.configOptions = [];
		this.availableCommands = [];
		this.availableModels = [];
		this.currentModelId = null;
		this.currentModeId = null;
		this.availableModes = [];
		this.lastPlanUpdateAt = null;
		this.resetStreamingState();
	}
}
