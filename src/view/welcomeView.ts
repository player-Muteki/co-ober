import { t, onLocaleChange } from '../i18n/index';
import type { AgentCapabilities } from '../types';

export type WelcomeStatus = 'connected' | 'connecting' | 'disconnected';

/**
 * Which of the three greeting states a pane is in. A client object is held
 * while the agent is still being reached — the handshake is in flight, or a
 * reconnect is after a drop — and a screen that says "Connected" at that
 * moment is telling the reader to type into a composer whose every send is
 * about to fail.
 */
export function connectionStatus(client: { isConnected(): boolean } | null): WelcomeStatus {
	if (!client) return 'disconnected';
	return client.isConnected() ? 'connected' : 'connecting';
}

function statusText(status: WelcomeStatus): string {
	if (status === 'connected') return t().welcome.connected;
	return status === 'connecting' ? t().welcome.connecting : t().welcome.disconnected;
}

export class WelcomeView {
	private welcomeEl: HTMLDivElement | null = null;
	private containerEl: HTMLElement;
	private status: WelcomeStatus = 'disconnected';
	private unsubscribeLocale: () => void;

	constructor(containerEl: HTMLElement, private getAgentCapabilities: () => AgentCapabilities | null = () => null) {
		this.containerEl = containerEl;
		this.unsubscribeLocale = onLocaleChange(() => {
			if (this.isVisible()) {
				this.show(this.status);
			}
		});
	}

	show(status: WelcomeStatus): void {
		this.status = status;
		this.hide();
		const welcome = this.containerEl.createDiv({ cls: 'co-ober-welcome' });
		this.welcomeEl = welcome;

		welcome.createDiv({ cls: 'co-ober-welcome-title', text: t().appName });
		welcome.createDiv({ cls: 'co-ober-welcome-subtitle', text: t().appSubtitle });

		const shortcuts = welcome.createDiv({ cls: 'co-ober-welcome-shortcuts' });
		shortcuts.createDiv({ text: t().welcome.shortcuts.enter });
		shortcuts.createDiv({ text: t().welcome.shortcuts.escape });
		shortcuts.createDiv({ text: t().welcome.shortcuts.at });
		shortcuts.createDiv({ text: t().welcome.shortcuts.slash });

		const statusEl = welcome.createDiv({ cls: 'co-ober-welcome-status' });
		statusEl.createSpan({ text: statusText(status) });
		this.renderAuthMethods(welcome, status);
	}

	private renderAuthMethods(welcome: HTMLDivElement, status: WelcomeStatus): void {
		// The list is what the agent reported over its handshake, so until that
		// is in hand there is nothing to show — and an unfinished attempt is the
		// one moment a reader might believe the login hint applies to them.
		if (status !== 'connected') return;
		const authMethods = this.getAgentCapabilities()?.authMethods ?? [];
		if (authMethods.length === 0) return;

		const authEl = welcome.createDiv({ cls: 'co-ober-welcome-auth-methods' });
		authEl.createDiv({ text: t().welcome.authMethodsHint });
		for (const method of authMethods) {
			authEl.createDiv({ text: `${method.id}: ${method.name}` });
		}
		authEl.createDiv({ text: t().welcome.authLoginCommand });
	}

	hide(): void {
		if (this.welcomeEl) {
			this.welcomeEl.remove();
			this.welcomeEl = null;
		}
	}

	updateStatus(status: WelcomeStatus): void {
		this.status = status;
		if (!this.welcomeEl) return;
		// The colouring rule selects the span inside the status line, so writing
		// the line's own text would move the words out from under it and leave a
		// connected greeting drawn in the disconnected colour.
		const span = this.welcomeEl.querySelector('.co-ober-welcome-status span');
		if (span) span.textContent = statusText(status);
		this.welcomeEl.querySelector('.co-ober-welcome-auth-methods')?.remove();
		this.renderAuthMethods(this.welcomeEl, status);
	}

	isVisible(): boolean {
		return this.welcomeEl !== null;
	}

	dispose(): void {
		this.unsubscribeLocale();
		this.hide();
	}

	/**
	 * Move the welcome host (and a visible welcome page) to another element —
	 * used when the active tab changes and each tab owns its message panel.
	 */
	reparent(containerEl: HTMLElement): void {
		this.containerEl = containerEl;
		if (this.welcomeEl) containerEl.appendChild(this.welcomeEl);
	}
}
