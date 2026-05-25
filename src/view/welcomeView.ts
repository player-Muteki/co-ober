import { t, onLocaleChange } from '../i18n/index';

export class WelcomeView {
	private welcomeEl: HTMLDivElement | null = null;
	private containerEl: HTMLElement;
	private isConnected = false;

	constructor(containerEl: HTMLElement) {
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
	}

	isVisible(): boolean {
		return this.welcomeEl !== null;
	}
}
