import type { PermissionRequest } from '../types';
import { t, onLocaleChange, lookupLocaleString } from '../i18n/index';
import { PERMISSION_MAX_LOCATIONS, PERMISSION_SUMMARY_MAX_KEYS, PERMISSION_TRUNCATE_LENGTH } from '../constants';

/** Points the banner at the tab that produced the request (multi-tab sessions). */
export interface PermissionOrigin {
  label: string;
  onFocus(): void;
}

export class PermissionBanner {
  private el: HTMLDivElement | null = null;
  private currentReq: { req: PermissionRequest; resolve: (val: string) => void; origin?: PermissionOrigin } | null = null;
  private readonly queue: Array<{ req: PermissionRequest; resolve: (val: string) => void; origin?: PermissionOrigin }> = [];
  private readonly unsubscribeLocale: () => void;

  constructor(private containerEl: HTMLElement) {
    this.unsubscribeLocale = onLocaleChange(() => {
      if (!this.el || !this.currentReq) return;
      this.renderBanner(this.currentReq.req, this.currentReq.origin);
    });
  }

  dispose(): void {
    this.unsubscribeLocale();
    this.settlePending();
  }

  show(req: PermissionRequest, origin?: PermissionOrigin): Promise<string> {
    return new Promise((resolve) => {
      // Concurrent requests queue up behind the visible one; force-rejecting
      // the previous request would punish work that was never shown.
      this.queue.push({ req, resolve, origin });
      if (!this.currentReq) this.showNext();
      else this.containerEl.scrollTop = this.containerEl.scrollHeight;
    });
  }

  private showNext(): void {
    const next = this.queue.shift();
    this.dismissInternal();
    if (!next) return;
    this.currentReq = next;
    this.renderBanner(next.req, next.origin);
    this.containerEl.scrollTop = this.containerEl.scrollHeight;
  }

  private renderBanner(req: PermissionRequest, origin?: PermissionOrigin): void {
    if (this.el) {
      this.el.remove();
      this.el = null;
    }

    const banner = this.containerEl.createDiv({ cls: 'co-ober-permission-banner' });
    this.el = banner;

    if (origin) {
      const originEl = banner.createDiv({ cls: 'perm-origin', text: origin.label });
      originEl.setAttribute('role', 'button');
      originEl.setAttribute('tabindex', '0');
      originEl.onclick = () => origin.onFocus();
      originEl.onkeydown = (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          origin.onFocus();
        }
      };
    }

    // Tool kind badge
    const kind = req.toolCall.kind || 'other';
    banner.createDiv({ cls: 'perm-kind', text: (lookupLocaleString(`toolKind.${kind}`) ?? kind).toUpperCase() });

    // Title
    const title = req.toolCall.title || req.toolCall.kind;
    banner.createDiv({ cls: 'perm-title', text: t().permission.title.replace('{title}', title) });

    // Locations
    if (req.toolCall.locations?.length) {
      const locationsEl = banner.createDiv({ cls: 'perm-locations' });
      for (const loc of req.toolCall.locations.slice(0, PERMISSION_MAX_LOCATIONS)) {
        locationsEl.createDiv({ cls: 'perm-path', text: loc.path });
      }
      if (req.toolCall.locations.length > PERMISSION_MAX_LOCATIONS) {
        locationsEl.createDiv({
          cls: 'perm-path-more',
          text: t().permission.moreLocations.replace(
            '{count}',
            String(req.toolCall.locations.length - PERMISSION_MAX_LOCATIONS),
          ),
        });
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
        const pending = this.currentReq;
        this.showNext();
        if (pending) pending.resolve(opt.optionId);
      };
    }
  }

  private summarizeInput(rawInput: Record<string, unknown>): string {
    const parts: string[] = [];
    const keys = Object.keys(rawInput);

    for (const key of keys.slice(0, PERMISSION_SUMMARY_MAX_KEYS)) {
      const value = rawInput[key];
      if (typeof value === 'string') {
        const truncated =
          value.length > PERMISSION_TRUNCATE_LENGTH ? value.slice(0, PERMISSION_TRUNCATE_LENGTH) + '...' : value;
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

  /** Drop the banner UI and resolve every outstanding request with a reject, so the agent never blocks. */
  private settlePending(): void {
    const outstanding = this.currentReq ? [this.currentReq, ...this.queue.splice(0)] : this.queue.splice(0);
    this.dismissInternal();
    for (const pending of outstanding) {
      const reject = pending.req.options.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always');
      pending.resolve(reject?.optionId ?? 'reject_once');
    }
  }

  dismiss(): void {
    this.settlePending();
  }

  /**
   * The agent reported a pending request (e.g. an elicitation) as resolved
   * outside this client, so retiring the banner must not leave the promise
   * hanging: settle it with the request's reject option. Ids that do not match
   * a visible or queued banner are ignored.
   */
  resolveExternally(toolCallId: string): void {
    const rejectValue = (req: PermissionRequest): string =>
      req.options.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always')?.optionId ?? 'reject_once';
    if (this.currentReq && this.currentReq.req.toolCall.toolCallId === toolCallId) {
      const pending = this.currentReq;
      this.showNext();
      pending.resolve(rejectValue(pending.req));
      return;
    }
    const index = this.queue.findIndex((entry) => entry.req.toolCall.toolCallId === toolCallId);
    if (index < 0) return;
    const [pending] = this.queue.splice(index, 1);
    pending.resolve(rejectValue(pending.req));
  }
}
