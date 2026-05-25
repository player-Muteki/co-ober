export interface KeybindingCallbacks {
	onNewSession: () => void;
	onClearScreen: () => void;
	onCopyLastMessage: () => void;
}

export class KeybindingManager {
	private globalKeyHandler: ((e: KeyboardEvent) => void) | null = null;

	constructor(
		private containerEl: HTMLElement,
		private callbacks: KeybindingCallbacks
	) {}

	register(): void {
		this.globalKeyHandler = (e: KeyboardEvent) => {
			const isMod = e.ctrlKey || e.metaKey;

			// Ctrl/Cmd + N → New session
			if (isMod && e.key.toLowerCase() === 'n' && !e.shiftKey) {
				e.preventDefault();
				this.callbacks.onNewSession();
				return;
			}

			// Ctrl/Cmd + L → Clear screen
			if (isMod && e.key.toLowerCase() === 'l' && !e.shiftKey) {
				e.preventDefault();
				this.callbacks.onClearScreen();
				return;
			}

			// Ctrl/Cmd + Shift + C → Copy last assistant message
			if (isMod && e.shiftKey && e.key.toLowerCase() === 'c') {
				e.preventDefault();
				this.callbacks.onCopyLastMessage();
				return;
			}
		};
		this.containerEl.addEventListener('keydown', this.globalKeyHandler);
	}

	unregister(): void {
		if (this.globalKeyHandler) {
			this.containerEl.removeEventListener('keydown', this.globalKeyHandler);
			this.globalKeyHandler = null;
		}
	}
}
