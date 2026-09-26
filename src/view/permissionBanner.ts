import type { ElicitationAnswer, ElicitationField, ElicitationRequest, PermissionDecision, PermissionRequest } from '../types';
import { t, onLocaleChange, lookupLocaleString } from '../i18n/index';
import { PERMISSION_MAX_LOCATIONS, PERMISSION_SUMMARY_MAX_KEYS, PERMISSION_TRUNCATE_LENGTH } from '../constants';

/** Points the banner at the tab that produced the request (multi-tab sessions). */
export interface PermissionOrigin {
  label: string;
  onFocus(): void;
}

type PendingPrompt =
  | { kind: 'permission'; req: PermissionRequest; origin?: PermissionOrigin; resolve: (decision: PermissionDecision) => void }
  | { kind: 'elicitation'; req: ElicitationRequest; origin?: PermissionOrigin; resolve: (answer: ElicitationAnswer) => void };

export class PermissionBanner {
  private el: HTMLDivElement | null = null;
  private current: PendingPrompt | null = null;
  private readonly queue: PendingPrompt[] = [];
  private readonly unsubscribeLocale: () => void;

  constructor(private containerEl: HTMLElement) {
    this.unsubscribeLocale = onLocaleChange(() => {
      // Redrawing a half-filled form would take the answer away from the user,
      // so an outstanding elicitation keeps the language it was drawn in.
      if (!this.current || this.current.kind === 'elicitation') return;
      this.render(this.current);
    });
  }

  dispose(): void {
    this.unsubscribeLocale();
    this.settlePending();
  }

  show(req: PermissionRequest, origin?: PermissionOrigin): Promise<PermissionDecision> {
    return new Promise((resolve) => {
      // Concurrent requests queue up behind the visible one; force-rejecting
      // the previous request would punish work that was never shown.
      this.queue.push({ kind: 'permission', req, resolve, origin });
      if (!this.current) this.showNext();
      else this.containerEl.scrollTop = this.containerEl.scrollHeight;
    });
  }

  /** Ask the user a question the agent posed, with one input per answerable field. */
  showElicitation(req: ElicitationRequest, origin?: PermissionOrigin): Promise<ElicitationAnswer> {
    return new Promise((resolve) => {
      this.queue.push({ kind: 'elicitation', req, resolve, origin });
      if (!this.current) this.showNext();
      else this.containerEl.scrollTop = this.containerEl.scrollHeight;
    });
  }

  private showNext(): void {
    const next = this.queue.shift();
    this.dismissInternal();
    if (!next) return;
    this.current = next;
    this.render(next);
    this.containerEl.scrollTop = this.containerEl.scrollHeight;
  }

  /**
   * Answer the visible prompt as "nobody answered": the agent is told the
   * request was cancelled, which is not the claim a reject button makes.
   * Returns false when no prompt is on screen, so the caller can let the key
   * carry on to whatever else it means (stopping the stream, for one).
   */
  cancelWithKeyboard(): boolean {
    const pending = this.current;
    if (!pending) return false;
    this.showNext();
    if (pending.kind === 'permission') pending.resolve(null);
    else pending.resolve({ action: 'cancel' });
    return true;
  }

  /** True while a prompt from any tab is waiting for an answer. */
  isPending(): boolean {
    return this.current !== null || this.queue.length > 0;
  }

  /**
   * The session the visible prompt belongs to. The caller decides whether that
   * is the tab the key press came from — a background tab's question stays
   * untouched when the active tab answers its own.
   */
  currentSessionId(): string | null {
    if (!this.current) return null;
    return this.current.req.sessionId ?? null;
  }

  private render(pending: PendingPrompt): void {
    if (this.el) {
      this.el.remove();
      this.el = null;
    }

    const banner = this.containerEl.createDiv({ cls: 'co-ober-permission-banner' });
    this.el = banner;

    if (pending.origin) {
      const origin = pending.origin;
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

    if (pending.kind === 'elicitation') {
      this.renderElicitation(banner, pending.req);
      this.makeOperable(banner);
      return;
    }
    this.renderPermission(banner, pending.req);
    this.makeOperable(banner);
  }

  /**
   * A prompt the keyboard cannot reach is a prompt only the mouse can answer:
   * it takes focus as it appears, and Esc retires it as "unanswered" rather
   * than leaving the key to whatever the composer thinks it means.
   */
  private makeOperable(banner: HTMLDivElement): void {
    banner.createDiv({ cls: 'perm-key-hint', text: t().permission.keyHint });
    banner.tabIndex = 0;
    banner.onkeydown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      this.cancelWithKeyboard();
    };
    const first = banner.querySelector<HTMLElement>('.perm-field-input, .perm-field-checkbox, .perm-btn');
    if (typeof first?.focus === 'function') first.focus({ preventScroll: true });
  }

  private renderPermission(banner: HTMLDivElement, req: PermissionRequest): void {
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
        const pending = this.current;
        this.showNext();
        if (pending && pending.kind === 'permission') pending.resolve(opt.optionId);
      };
    }
  }

  private renderElicitation(banner: HTMLDivElement, req: ElicitationRequest): void {
    const i18n = t();
    banner.createDiv({ cls: 'perm-kind', text: i18n.elicitation.title });
    banner.createDiv({ cls: 'perm-title', text: req.message || i18n.elicitation.title });

    if (req.url) {
      banner.createEl('a', {
        cls: 'perm-elicit-url',
        text: req.url,
        attr: { href: req.url, target: '_blank', rel: 'noopener noreferrer' },
      });
    }

    const inputs = new Map<ElicitationField, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>();
    for (const field of req.fields) {
      const row = banner.createDiv({ cls: 'perm-field' });
      const label = row.createEl('label', { cls: 'perm-field-label', text: field.label });
      if (field.required) label.append(row.createSpan({ cls: 'perm-field-required', text: ' *' }));
      if (field.description) row.createDiv({ cls: 'perm-field-desc', text: field.description });
      const id = `co-ober-elicit-${field.key}`;
      label.setAttribute('for', id);
      inputs.set(field, this.renderField(row, field, id));
    }

    // A partial answer is still what the agent gets; the reader learns it here
    // rather than from an agent that asks the same question again.
    if (req.omittedFields.length > 0) {
      banner.createDiv({
        cls: 'perm-elicit-omitted',
        text: i18n.elicitation.omittedFields.replace('{fields}', req.omittedFields.join(', ')),
      });
    }

    const hint = banner.createDiv({ cls: 'perm-elicit-hint', text: i18n.elicitation.requiredMissing });
    hint.hidden = true;

    const actions = banner.createDiv({ cls: 'perm-actions' });
    const accept = actions.createEl('button', {
      text: req.url && req.fields.length === 0 ? i18n.elicitation.opened : i18n.elicitation.accept,
      cls: 'perm-btn perm-accept',
    });
    const decline = actions.createEl('button', { text: i18n.elicitation.decline, cls: 'perm-btn perm-reject_once' });

    const answer = (value: ElicitationField, input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): unknown => {
      if (value.kind === 'boolean') return (input as HTMLInputElement).checked;
      const raw = input.value.trim();
      if (!raw) return undefined;
      if (value.kind === 'number') {
        const asNumber = Number(raw);
        return Number.isFinite(asNumber) ? asNumber : undefined;
      }
      return raw;
    };

    accept.onclick = () => {
      const content: Record<string, string | number | boolean> = {};
      let missing = false;
      for (const field of req.fields) {
        const value = answer(field, inputs.get(field)!);
        if (value === undefined) {
          if (field.required) missing = true;
          continue;
        }
        content[field.key] = value as string | number | boolean;
      }
      // Required fields left blank are the user's choice to keep editing, not
      // an answer to send: the banner stays and says what is still missing.
      if (missing) {
        hint.hidden = false;
        return;
      }
      const pending = this.current;
      this.showNext();
      if (pending && pending.kind === 'elicitation') pending.resolve({ action: 'accept', content });
    };
    decline.onclick = () => {
      const pending = this.current;
      this.showNext();
      if (pending && pending.kind === 'elicitation') pending.resolve({ action: 'decline' });
    };
  }

  private renderField(
    row: HTMLElement,
    field: ElicitationField,
    id: string,
  ): HTMLInputElement | HTMLSelectElement {
    if (field.kind === 'enum') {
      const select = row.createEl('select', { cls: 'perm-field-input', attr: { id } });
      // An unchosen option, so a select never answers for the user by default.
      select.createEl('option', { text: '—', attr: { value: '' } });
      for (const option of field.values ?? []) {
        select.createEl('option', { text: option.label, attr: { value: option.value } });
      }
      return select;
    }
    if (field.kind === 'boolean') {
      return row.createEl('input', { cls: 'perm-field-checkbox', attr: { id, type: 'checkbox' } });
    }
    return row.createEl('input', {
      cls: 'perm-field-input',
      attr: { id, ...(field.kind === 'number' ? { type: 'number' } : { type: 'text' }) },
    });
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
    this.current = null;
  }

  /** Drop the banner UI and settle every outstanding request, so the agent never blocks. */
  private settlePending(): void {
    const outstanding = this.current ? [this.current, ...this.queue.splice(0)] : this.queue.splice(0);
    this.dismissInternal();
    for (const pending of outstanding) {
      if (pending.kind === 'permission') {
        const reject = pending.req.options.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always');
        pending.resolve(reject?.optionId ?? 'reject_once');
      } else {
        // Retiring a form the user never submitted is "nobody answered", not a
        // refusal the agent should report back as the user's decision.
        pending.resolve({ action: 'cancel' });
      }
    }
  }

  dismiss(): void {
    this.settlePending();
  }

  /**
   * The agent reported a pending request (e.g. an elicitation) as resolved
   * outside this client, so retiring the banner must not leave the promise
   * hanging. Ids that do not match a visible or queued banner are ignored.
   */
  resolveExternally(toolCallId: string): void {
    const matches = (pending: PendingPrompt): boolean =>
      pending.kind === 'permission'
        ? pending.req.toolCall.toolCallId === toolCallId
        : pending.req.elicitationId === toolCallId;
    const rejectPermission = (req: PermissionRequest): string =>
      req.options.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always')?.optionId ?? 'reject_once';

    if (this.current && matches(this.current)) {
      const pending = this.current;
      this.showNext();
      if (pending.kind === 'permission') pending.resolve(rejectPermission(pending.req));
      else pending.resolve({ action: 'cancel' });
      return;
    }
    const index = this.queue.findIndex(matches);
    if (index < 0) return;
    const [pending] = this.queue.splice(index, 1);
    if (pending.kind === 'permission') pending.resolve(rejectPermission(pending.req));
    else pending.resolve({ action: 'cancel' });
  }
}
