import type { PermissionRequest } from '../types';
import { t, onLocaleChange } from '../i18n/index';

export class PermissionBanner {
	private el: HTMLDivElement | null = null;
	private currentReq: { req: PermissionRequest, resolve: (val: string) => void } | null = null;
	private readonly unsubscribeLocale: () => void;

	constructor(private containerEl: HTMLElement) {
		this.unsubscribeLocale = onLocaleChange(() => {
			if (!this.el || !this.currentReq) return;
			this.renderBanner(this.currentReq.req);
		});
	}

	dispose(): void {
		this.unsubscribeLocale();
		this.dismissInternal();
	}

	show(req: PermissionRequest): Promise<string> {
		return new Promise((resolve) => {
			this.currentReq = { req, resolve };
			// Remove existing UI element but keep currentReq intact.
			if (this.el) {
				this.el.remove();
				this.el = null;
			}
			this.renderBanner(req);
			this.containerEl.scrollTop = this.containerEl.scrollHeight;
		});
	}

	private renderBanner(req: PermissionRequest): void {
		if (this.el) {
			this.el.remove();
			this.el = null;
		}

		const banner = this.containerEl.createDiv({ cls: 'co-ober-permission-banner' });
		this.el = banner;

		// Tool kind badge
		const kind = req.toolCall.kind || 'other';
		banner.createDiv({ cls: 'perm-kind', text: kind.toUpperCase() });

		// Title
		const title = req.toolCall.title || req.toolCall.kind;
		banner.createDiv({ cls: 'perm-title', text: t().permission.title.replace('{title}', title) });

		// Locations
		if (req.toolCall.locations?.length) {
			const locationsEl = banner.createDiv({ cls: 'perm-locations' });
			for (const loc of req.toolCall.locations.slice(0, 3)) {
				locationsEl.createDiv({ cls: 'perm-path', text: loc.path });
			}
			if (req.toolCall.locations.length > 3) {
				locationsEl.createDiv({ cls: 'perm-path-more', text: `+${req.toolCall.locations.length - 3} more` });
			}
		}

		// Raw input summary (if available)
		if (req.toolCall.rawInput && Object.keys(req.toolCall.rawInput).length > 0) {
			const inputSummary = this.summarizeInput(req.toolCall.rawInput);
			if (inputSummary) {
				banner.createDiv({ cls: 'perm-input', text: inputSummary });
			}
		}

		// Actions
		const actions = banner.createDiv({ cls: 'perm-actions' });
		for (const opt of req.options) {
			const btn = actions.createEl('button', {
				text: opt.name,
				cls: `perm-btn perm-${opt.kind}`,
			});
			btn.onclick = () => {
				const resolve = this.currentReq?.resolve;
				this.dismissInternal();
				if (resolve) resolve(opt.optionId);
			};
		}
	}

	private summarizeInput(rawInput: Record<string, unknown>): string {
		const parts: string[] = [];
		const keys = Object.keys(rawInput);

		for (const key of keys.slice(0, 3)) {
			const value = rawInput[key];
			if (typeof value === 'string') {
				const truncated = value.length > 50 ? value.slice(0, 50) + '...' : value;
				parts.push(`${key}: ${truncated}`);
			} else if (typeof value === 'number' || typeof value === 'boolean') {
				parts.push(`${key}: ${value}`);
			}
		}

		return parts.join(', ');
	}

	private dismissInternal(): void {
		if (this.el) {
			this.el.remove();
			this.el = null;
		}
		this.currentReq = null;
	}

	dismiss(): void {
		this.dismissInternal();
	}
}
