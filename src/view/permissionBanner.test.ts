// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { PermissionBanner } from './permissionBanner';
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

  it('dismiss() resolves the pending request with a reject option so the agent never blocks', async () => {
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

    expect(await promise).toBe('no');
    expect(container.querySelector('.co-ober-permission-banner')).toBeNull();
  });

  it('dismiss() falls back to reject_once when the request has no reject option', async () => {
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

    expect(await promise).toBe('reject_once');
  });

  it('a second show() settles the previous pending request with a reject', async () => {
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

    // The overwritten first request resolves instead of hanging forever.
    expect(await first).toBe('no1');

    // The second request is still live and can be answered normally.
    const buttons = container.querySelectorAll('.perm-actions button');
    (buttons[0] as HTMLButtonElement).click();
    expect(await second).toBe('yes2');
  });

  it('cleans up old banner when show is called consecutively', () => {
    const container = document.createElement('div');
    const banner = new PermissionBanner(container);

    banner.show({
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
    expect(title?.textContent).toContain('New req');

    // Resolve new request to finish cleanly
    (banners[0].querySelector('button') as HTMLButtonElement).click();

    return req2.then((res) => {
      expect(res).toBe('ok2');
    });
  });
});
