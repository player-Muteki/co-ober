import { t, onLocaleChange } from '../i18n/index';
import type { AgentCapabilities } from '../types';

export class WelcomeView {
	private welcomeEl: HTMLDivElement | null = null;
	private containerEl: HTMLElement;
	private isConnected = false;

	constructor(containerEl: HTMLElement, private getAgentCapabilities: () => AgentCapabilities | null = () => null) {
		this.containerEl = containerEl;
		onLocaleChange(() => {
			if (this.isVisible()) {
				this.show(this.isConnected);
			}
		});
	}

	show(isConnected: boolean): void {
		this.isConnected = isConnected;
		this.hide();
		const welcome = this.containerEl.createDiv({ cls: 'copsidian-welcome' });
		this.welcomeEl = welcome;

		welcome.createDiv({ cls: 'copsidian-welcome-title', text: t().appName });
		welcome.createDiv({ cls: 'copsidian-welcome-subtitle', text: t().appSubtitle });

		const shortcuts = welcome.createDiv({ cls: 'copsidian-welcome-shortcuts' });
		shortcuts.createDiv({ text: t().welcome.shortcuts.enter });
		shortcuts.createDiv({ text: t().welcome.shortcuts.escape });
		shortcuts.createDiv({ text: t().welcome.shortcuts.at });
		shortcuts.createDiv({ text: t().welcome.shortcuts.slash });

		const status = welcome.createDiv({ cls: 'copsidian-welcome-status' });
		status.createSpan({ text: isConnected ? t().welcome.connected : t().welcome.disconnected });
		this.renderAuthMethods(welcome, isConnected);
	}

	private renderAuthMethods(welcome: HTMLDivElement, isConnected: boolean): void {
		if (!isConnected) return;
		const authMethods = this.getAgentCapabilities()?.authMethods ?? [];
		if (authMethods.length === 0) return;

		const authEl = welcome.createDiv({ cls: 'copsidian-welcome-auth-methods' });
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

	updateStatus(isConnected: boolean): void {
		this.isConnected = isConnected;
		if (!this.welcomeEl) return;
		const status = this.welcomeEl.querySelector('.copsidian-welcome-status');
		if (!status) return;
		status.textContent = isConnected ? t().welcome.connected : t().welcome.disconnected;
		this.welcomeEl.querySelector('.copsidian-welcome-auth-methods')?.remove();
		this.renderAuthMethods(this.welcomeEl, isConnected);
	}

	isVisible(): boolean {
		return this.welcomeEl !== null;
	}
}
