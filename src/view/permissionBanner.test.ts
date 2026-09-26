// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { PermissionBanner } from './permissionBanner';
import { setLocale } from '../i18n/index';
import type { ElicitationAnswer } from '../types';
import { installObsidianDomHelpers } from '../test/domHelpers';

installObsidianDomHelpers();

describe('PermissionBanner', () => {
  it('shows correctly with multiple options', () => {
    const container = document.createElement('div');
    const banner = new PermissionBanner(container);

    const promise = banner.show({
      id: 'req1',
      message: 'Test permission?',
      toolCall: {
        toolCallId: '1',
        status: 'pending',
        rawInput: {},
        title: 'Test permission?',
        kind: 'edit',
        locations: [],
      },
      options: [
        { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
        { optionId: 'no', name: 'No', kind: 'reject_once' },
      ],
    } as any);

    const el = container.querySelector('.co-ober-permission-banner');
    expect(el).not.toBeNull();

    const title = el?.querySelector('.perm-title');
    expect(title?.textContent).toContain('Test permission?');

    const buttons = el?.querySelectorAll('.perm-actions button');
    expect(buttons?.length).toBe(2);
    expect(buttons?.[0].textContent).toBe('Yes');
    expect(buttons?.[1].textContent).toBe('No');

    // Click the first button
    (buttons?.[0] as HTMLButtonElement).click();

    return promise.then((res) => {
      expect(res).toBe('yes');
    });
  });

  it('dismisses cleanly', () => {
    const container = document.createElement('div');
    const banner = new PermissionBanner(container);

    banner.show({
      id: 'req2',
      message: 'Test permission 2?',
      toolCall: {
        toolCallId: '2',
        status: 'pending',
        rawInput: {},
        title: 'Test permission 2?',
        kind: 'edit',
        locations: [],
      },
      options: [{ optionId: 'ok', name: 'OK', kind: 'allow_once' }],
    } as any);

    expect(container.querySelector('.co-ober-permission-banner')).not.toBeNull();

    banner.dismiss();

    expect(container.querySelector('.co-ober-permission-banner')).toBeNull();
  });

  it('dismiss() answers the pending request as nobody-answered, so the agent never blocks', async () => {
    const container = document.createElement('div');
    const banner = new PermissionBanner(container);

    const promise = banner.show({
      id: 'req-d1',
      message: 'Dangerous?',
      toolCall: {
        toolCallId: 'd1',
        status: 'pending',
        rawInput: {},
        title: 'Dangerous?',
        kind: 'execute',
        locations: [],
      },
      options: [
        { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
        { optionId: 'no', name: 'No', kind: 'reject_once' },
      ],
    } as any);

    banner.dismiss();

    // A reject option is a claim about what the user chose. Retiring a banner
    // they never answered says "nobody answered" — the same answer Esc gives.
    expect(await promise).toBeNull();
    expect(container.querySelector('.co-ober-permission-banner')).toBeNull();
  });

  it('dismiss() answers a request with no reject option the same way', async () => {
    const container = document.createElement('div');
    const banner = new PermissionBanner(container);

    const promise = banner.show({
      id: 'req-d2',
      message: 'Only allow?',
      toolCall: {
        toolCallId: 'd2',
        status: 'pending',
        rawInput: {},
        title: 'Only allow?',
        kind: 'edit',
        locations: [],
      },
      options: [{ optionId: 'ok', name: 'OK', kind: 'allow_once' }],
    } as any);

    banner.dismiss();

    expect(await promise).toBeNull();
  });

  it('a second concurrent show() queues behind the visible request', async () => {
    const container = document.createElement('div');
    const banner = new PermissionBanner(container);

    const first = banner.show({
      id: 'req-o1',
      message: 'First?',
      toolCall: { toolCallId: 'o1', status: 'pending', rawInput: {}, title: 'First?', kind: 'edit', locations: [] },
      options: [
        { optionId: 'yes1', name: 'Yes1', kind: 'allow_once' },
        { optionId: 'no1', name: 'No1', kind: 'reject_once' },
      ],
    } as any);

    const second = banner.show({
      id: 'req-o2',
      message: 'Second?',
      toolCall: { toolCallId: 'o2', status: 'pending', rawInput: {}, title: 'Second?', kind: 'edit', locations: [] },
      options: [{ optionId: 'yes2', name: 'Yes2', kind: 'allow_once' }],
    } as any);

    // The first request stays visible; nothing is force-rejected.
    let banners = container.querySelectorAll('.co-ober-permission-banner');
    expect(banners.length).toBe(1);
    expect(banners[0].querySelector('.perm-title')?.textContent).toContain('First?');

    // Answering the first promotes the queued second request.
    (banners[0].querySelector('.perm-actions button') as HTMLButtonElement).click();
    expect(await first).toBe('yes1');

    banners = container.querySelectorAll('.co-ober-permission-banner');
    expect(banners.length).toBe(1);
    expect(banners[0].querySelector('.perm-title')?.textContent).toContain('Second?');
    (banners[0].querySelector('.perm-actions button') as HTMLButtonElement).click();
    expect(await second).toBe('yes2');
    expect(container.querySelector('.co-ober-permission-banner')).toBeNull();
  });

  it('dismiss() settles every queued request as unanswered', async () => {
    const container = document.createElement('div');
    const banner = new PermissionBanner(container);

    const first = banner.show({
      id: 'req-q1',
      message: 'First?',
      toolCall: { toolCallId: 'q1', status: 'pending', rawInput: {}, title: 'First?', kind: 'edit', locations: [] },
      options: [{ optionId: 'yes1', name: 'Yes1', kind: 'allow_once' }],
    } as any);

    const second = banner.show({
      id: 'req-q2',
      message: 'Second?',
      toolCall: { toolCallId: 'q2', status: 'pending', rawInput: {}, title: 'Second?', kind: 'edit', locations: [] },
      options: [{ optionId: 'yes2', name: 'Yes2', kind: 'allow_once' }],
    } as any);

    banner.dismiss();

    expect(await first).toBeNull();
    expect(await second).toBeNull();
    expect(container.querySelector('.co-ober-permission-banner')).toBeNull();
  });

  it('dismiss(sessionIds) answers one tab prompts and leaves another on screen', async () => {
    const container = document.createElement('div');
    const banner = new PermissionBanner(container);

    const mine = banner.show({
      sessionId: 'ses-mine',
      id: 'req-s1',
      message: 'Mine?',
      toolCall: { toolCallId: 's1', status: 'pending', rawInput: {}, title: 'Mine?', kind: 'edit', locations: [] },
      options: [{ optionId: 'yes1', name: 'Yes1', kind: 'allow_once' }],
    } as any);

    const theirs = banner.show({
      sessionId: 'ses-theirs',
      id: 'req-s2',
      message: 'Theirs?',
      toolCall: { toolCallId: 's2', status: 'pending', rawInput: {}, title: 'Theirs?', kind: 'edit', locations: [] },
      options: [{ optionId: 'yes2', name: 'Yes2', kind: 'allow_once' }],
    } as any);

    banner.dismiss(['ses-mine']);

    // The tab that went away gets its honest answer...
    expect(await mine).toBeNull();
    // ...and the tab still on screen keeps the question it was never asked to drop.
    expect(banner.isPending()).toBe(true);
    expect(container.querySelector('.co-ober-permission-banner')?.textContent).toContain('Theirs?');

    banner.dismiss();
    expect(await theirs).toBeNull();
  });

  it('dismiss(sessionIds) promotes the next unscoped request into view', async () => {
    const container = document.createElement('div');
    const banner = new PermissionBanner(container);

    const first = banner.show({
      sessionId: 'ses-a',
      id: 'req-p1',
      message: 'Asking tab?',
      toolCall: { toolCallId: 'p1', status: 'pending', rawInput: {}, title: 'Asking tab?', kind: 'edit', locations: [] },
      options: [{ optionId: 'yes1', name: 'Yes1', kind: 'allow_once' }],
    } as any);

    const queuedOther = banner.show({
      sessionId: 'ses-b',
      id: 'req-p2',
      message: 'Other tab?',
      toolCall: { toolCallId: 'p2', status: 'pending', rawInput: {}, title: 'Other tab?', kind: 'edit', locations: [] },
      options: [{ optionId: 'yes2', name: 'Yes2', kind: 'allow_once' }],
    } as any);

    const queuedSame = banner.show({
      sessionId: 'ses-a',
      id: 'req-p3',
      message: 'Again, asking tab?',
      toolCall: { toolCallId: 'p3', status: 'pending', rawInput: {}, title: 'Again, asking tab?', kind: 'edit', locations: [] },
      options: [{ optionId: 'yes3', name: 'Yes3', kind: 'allow_once' }],
    } as any);

    banner.dismiss(['ses-a']);

    // Both of the closing tab's prompts settle, visible one first, and the
    // other tab's queued question is what the user is left looking at.
    expect(await first).toBeNull();
    expect(await queuedSame).toBeNull();
    expect(container.querySelector('.co-ober-permission-banner')?.textContent).toContain('Other tab?');
    expect(banner.currentSessionId()).toBe('ses-b');

    banner.dismiss();
    expect(await queuedOther).toBeNull();
  });

  it('shows exactly one banner while requests queue', async () => {    const container = document.createElement('div');
    const banner = new PermissionBanner(container);

    const req1 = banner.show({
      id: 'req3',
      message: 'Old req',
      toolCall: { toolCallId: '3', status: 'pending', rawInput: {}, title: 'Old req', kind: 'edit', locations: [] },
      options: [{ optionId: 'ok', name: 'OK', kind: 'allow_once' }],
    } as any);

    const req2 = banner.show({
      id: 'req4',
      message: 'New req',
      toolCall: { toolCallId: '4', status: 'pending', rawInput: {}, title: 'New req', kind: 'edit', locations: [] },
      options: [{ optionId: 'ok2', name: 'OK2', kind: 'allow_once' }],
    } as any);

    const banners = container.querySelectorAll('.co-ober-permission-banner');
    expect(banners.length).toBe(1);

    const title = banners[0].querySelector('.perm-title');
    expect(title?.textContent).toContain('Old req');

    // Resolve first request to finish cleanly; the queued one then renders.
    (banners[0].querySelector('button') as HTMLButtonElement).click();
    expect(await req1).toBe('ok');
    const nextBanner = container.querySelector('.co-ober-permission-banner');
    expect(nextBanner?.querySelector('.perm-title')?.textContent).toContain('New req');
    (nextBanner?.querySelector('button') as HTMLButtonElement).click();
    expect(await req2).toBe('ok2');
  });

  describe('resolveExternally', () => {
    const req = (id: string, title: string) => ({
      id: `req-${id}`,
      message: title,
      toolCall: { toolCallId: id, status: 'pending', rawInput: {}, title, kind: 'other', locations: [] },
      options: [
        { optionId: 'accept', name: 'Accept', kind: 'accept' },
        { optionId: 'decline', name: 'Decline', kind: 'reject_once' },
      ],
    });

    it('settles the visible banner with its reject option and promotes the queue', async () => {
      const container = document.createElement('div');
      const banner = new PermissionBanner(container);

      const first = banner.show(req('e1', 'First?') as any);
      const second = banner.show(req('e2', 'Second?') as any);

      banner.resolveExternally('e1');
      expect(await first).toBe('decline');
      expect(container.querySelector('.perm-title')?.textContent).toContain('Second?');

      banner.resolveExternally('e2');
      expect(await second).toBe('decline');
      expect(container.querySelector('.co-ober-permission-banner')).toBeNull();
    });

    it('removes a queued request without disturbing the visible one', async () => {
      const container = document.createElement('div');
      const banner = new PermissionBanner(container);

      const first = banner.show(req('e1', 'First?') as any);
      const queued = banner.show(req('e2', 'Second?') as any);

      banner.resolveExternally('e2');
      expect(await queued).toBe('decline');
      expect(container.querySelector('.perm-title')?.textContent).toContain('First?');

      (container.querySelector('.perm-actions button') as HTMLButtonElement).click();
      expect(await first).toBe('accept');
      expect(container.querySelector('.co-ober-permission-banner')).toBeNull();
    });

    it('ignores ids that match no outstanding request', async () => {
      const container = document.createElement('div');
      const banner = new PermissionBanner(container);

      const first = banner.show(req('e1', 'First?') as any);
      banner.resolveExternally('other-client-elicitation');
      expect(container.querySelector('.perm-title')?.textContent).toContain('First?');

      (container.querySelector('.perm-actions button') as HTMLButtonElement).click();
      expect(await first).toBe('accept');
    });

    it('falls back to reject_once when the settled request has no reject option', async () => {
      const container = document.createElement('div');
      const banner = new PermissionBanner(container);

      const promise = banner.show({
        id: 'req-no-reject',
        message: 'Allow only?',
        toolCall: { toolCallId: 'e3', status: 'pending', rawInput: {}, title: 'Allow only?', kind: 'edit', locations: [] },
        options: [{ optionId: 'ok', name: 'OK', kind: 'allow_once' }],
      } as any);

      banner.resolveExternally('e3');
      expect(await promise).toBe('reject_once');
    });
  });
});

describe('PermissionBanner elicitations', () => {
  const elicit = (over: Record<string, unknown> = {}) => ({
    sessionId: 's1',
    elicitationId: 'el-1',
    message: 'Which environment?',
    fields: [
      { key: 'target', label: 'Target', required: true, kind: 'text' },
      { key: 'retries', label: 'Retries', required: false, kind: 'number' },
    ],
    omittedFields: [],
    ...over,
  });

  const buttons = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLButtonElement>('.perm-actions button'));

  it('puts one labelled input against every field the agent asked for', () => {
    const container = document.createElement('div');
    const banner = new PermissionBanner(container);

    void banner.showElicitation(elicit() as any);

    const rows = container.querySelectorAll('.perm-field');
    expect(rows.length).toBe(2);
    expect(rows[0].querySelector('.perm-field-label')?.textContent).toContain('Target');
    expect(rows[0].querySelector('.perm-field-required')?.textContent).toBe(' *');
    expect(rows[1].querySelector('.perm-field-label')?.textContent).toContain('Retries');
    expect(rows[1].querySelector('.perm-field-required')).toBeNull();
    expect(rows[0].querySelector('input[type=text]')).not.toBeNull();
    expect(rows[1].querySelector('input[type=number]')).not.toBeNull();
    // The label points at its own input, so clicking it focuses the answer.
    expect(rows[0].querySelector('label')?.getAttribute('for')).toBe(rows[0].querySelector('input')?.id);
    banner.dispose();
  });

  it('answers with what the user typed, parsed per field kind', () => {
    const container = document.createElement('div');
    const banner = new PermissionBanner(container);

    const promise = banner.showElicitation(elicit() as any);
    (container.querySelectorAll('.perm-field input')[0] as HTMLInputElement).value = ' prod ';
    (container.querySelectorAll('.perm-field input')[1] as HTMLInputElement).value = '3';
    buttons(container)[0].click();

    return expect(promise).resolves.toEqual({ action: 'accept', content: { target: 'prod', retries: 3 } });
  });

  it('keeps the form open and says what is missing when a required field is blank', async () => {
    const container = document.createElement('div');
    const banner = new PermissionBanner(container);

    let settled: ElicitationAnswer | null = null;
    const promise = banner.showElicitation(elicit() as any).then((answer) => {
      settled = answer;
      return answer;
    });
    const hint = container.querySelector('.perm-elicit-hint') as HTMLElement;
    expect(hint.hidden).toBe(true);

    buttons(container)[0].click();
    expect(hint.hidden).toBe(false);
    expect(container.querySelector('.co-ober-permission-banner')).not.toBeNull();

    await Promise.resolve();
    expect(settled).toBe(null);

    (container.querySelector('.perm-field input') as HTMLInputElement).value = 'dev';
    buttons(container)[0].click();
    await expect(promise).resolves.toEqual({ action: 'accept', content: { target: 'dev' } });
  });

  it('offers an enum as a choice the user has to make, never a default answer', async () => {
    const container = document.createElement('div');
    const banner = new PermissionBanner(container);

    const promise = banner.showElicitation({
      ...elicit({
        fields: [{ key: 'target', label: 'Target', required: true, kind: 'enum', values: [{ value: 'dev', label: 'Dev' }, { value: 'prod', label: 'Prod' }] }],
      }),
    } as any);

    const select = container.querySelector('select.perm-field-input') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'dev', 'prod']);
    expect(select.value).toBe('');

    buttons(container)[0].click();
    expect((container.querySelector('.perm-elicit-hint') as HTMLElement).hidden).toBe(false);

    select.value = 'prod';
    buttons(container)[0].click();
    await expect(promise).resolves.toEqual({ action: 'accept', content: { target: 'prod' } });
  });

  it('reads a boolean field from its checkbox rather than its text', async () => {
    const container = document.createElement('div');
    const banner = new PermissionBanner(container);

    const promise = banner.showElicitation(
      elicit({ fields: [{ key: 'force', label: 'Force', required: false, kind: 'boolean' }] }) as any,
    );
    const box = container.querySelector('input[type=checkbox]') as HTMLInputElement;
    expect(box.checked).toBe(false);
    buttons(container)[0].click();
    await expect(promise).resolves.toEqual({ action: 'accept', content: { force: false } });
  });

  it('names the parts of the request it cannot answer', () => {
    const container = document.createElement('div');
    const banner = new PermissionBanner(container);

    void banner.showElicitation(elicit({ omittedFields: ['window', 'assignee'] }) as any);

    expect(container.querySelector('.perm-elicit-omitted')?.textContent).toContain('window, assignee');
    banner.dispose();
  });

  it('shows a url-mode link as a link and answers that it was opened', async () => {
    const container = document.createElement('div');
    const banner = new PermissionBanner(container);

    const promise = banner.showElicitation(
      elicit({ url: 'https://example.test/sign-in', fields: [] }) as any,
    );

    const link = container.querySelector('a.perm-elicit-url') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://example.test/sign-in');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(buttons(container)[0].textContent).toBe('I opened it');

    buttons(container)[0].click();
    await expect(promise).resolves.toEqual({ action: 'accept', content: {} });
  });

  it('a declined question travels as a decline, not as a blank answer', () => {
    const container = document.createElement('div');
    const banner = new PermissionBanner(container);

    const promise = banner.showElicitation(elicit() as any);
    buttons(container)[1].click();
    return expect(promise).resolves.toEqual({ action: 'decline' });
  });

  it('cancels an unanswered question when the banner is retired, and when the agent settles it', () => {
    const container = document.createElement('div');
    const banner = new PermissionBanner(container);

    const dismissed = banner.showElicitation(elicit({ elicitationId: 'el-a' }) as any);
    banner.dismiss();
    const settled = banner.showElicitation(elicit({ elicitationId: 'el-b' }) as any);
    banner.resolveExternally('el-b');

    return Promise.all([dismissed, settled]).then(([a, b]) => {
      expect(a).toEqual({ action: 'cancel' });
      expect(b).toEqual({ action: 'cancel' });
    });
  });

  it('leaves a half-filled question alone when the language changes', () => {
    const container = document.createElement('div');
    const banner = new PermissionBanner(container);

    void banner.showElicitation(elicit() as any);
    const input = container.querySelector('.perm-field input') as HTMLInputElement;
    input.value = 'half-typed';

    setLocale('en');

    // Redrawing would hand back an empty form; the same element is still there.
    expect(container.querySelector('.perm-field input')).toBe(input);
    expect((container.querySelector('.perm-field input') as HTMLInputElement).value).toBe('half-typed');
    banner.dispose();
  });
});

function permission(overrides: Record<string, unknown> = {}): unknown {
  return {
    sessionId: 'session-a',
    toolCall: {
      toolCallId: 'tc-1',
      status: 'pending',
      rawInput: {},
      title: 'Edit note',
      kind: 'edit',
      locations: [],
    },
    options: [
      { optionId: 'yes', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'no', kind: 'reject_once', name: 'Reject once' },
    ],
    ...overrides,
  };
}

describe('PermissionBanner keyboard access', () => {
  it('takes the keyboard with it as the prompt appears', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const banner = new PermissionBanner(container);

    void banner.show(permission() as any);
    const first = container.querySelector('.perm-btn') as HTMLButtonElement;
    expect(document.activeElement).toBe(first);
    banner.dispose();
    container.remove();
  });

  it('says on screen how the prompt can be answered by hand', () => {
    const container = document.createElement('div');
    const banner = new PermissionBanner(container);

    void banner.show(permission() as any);
    const hint = container.querySelector('.perm-key-hint');
    expect(hint?.textContent).toContain('Esc');
    banner.dispose();
  });

  it('answers Escape as nobody answered, which is not a refusal', async () => {
    const container = document.createElement('div');
    const banner = new PermissionBanner(container);
    const answered = banner.show(permission() as any);

    expect(banner.cancelWithKeyboard()).toBe(true);
    await expect(answered).resolves.toBeNull();
    expect(container.querySelector('.co-ober-permission-banner')).toBeNull();
    banner.dispose();
  });

  it('retires an elicitation on Escape as cancelled rather than declined', async () => {
    const container = document.createElement('div');
    const banner = new PermissionBanner(container);
    const answered = banner.showElicitation({
      sessionId: 'session-a',
      elicitationId: 'el-1',
      message: 'Which file?',
      fields: [{ key: 'path', label: 'Path', kind: 'text', required: true }],
      omittedFields: [],
    } as any);

    expect(banner.cancelWithKeyboard()).toBe(true);
    await expect(answered).resolves.toEqual({ action: 'cancel' });
    banner.dispose();
  });

  it('leaves Escape alone when nothing is waiting for it', () => {
    const container = document.createElement('div');
    const banner = new PermissionBanner(container);

    expect(banner.cancelWithKeyboard()).toBe(false);
    expect(banner.currentSessionId()).toBeNull();
    banner.dispose();
  });

  it('names the session the visible prompt belongs to, and the next one after it', () => {
    const container = document.createElement('div');
    const banner = new PermissionBanner(container);

    void banner.show(permission({ sessionId: 'session-a' }) as any);
    void banner.show(permission({ sessionId: 'session-b' }) as any);
    expect(banner.currentSessionId()).toBe('session-a');
    expect(banner.isPending()).toBe(true);

    banner.cancelWithKeyboard();
    expect(banner.currentSessionId()).toBe('session-b');
    expect(banner.isPending()).toBe(true);

    banner.cancelWithKeyboard();
    expect(banner.currentSessionId()).toBeNull();
    expect(banner.isPending()).toBe(false);
    banner.dispose();
  });

  it('answers Escape from the banner itself, without the caller asking', async () => {
    const container = document.createElement('div');
    const banner = new PermissionBanner(container);
    const answered = banner.show(permission() as any);

    const el = container.querySelector('.co-ober-permission-banner') as HTMLElement;
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    const stopped = !el.dispatchEvent(event);

    expect(stopped).toBe(true);
    await expect(answered).resolves.toBeNull();
    banner.dispose();
  });
});
