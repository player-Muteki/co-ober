// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { SessionRuntime } from './sessionRuntime';
import type { ChatRenderer } from '../view/renderer';
import { installObsidianDomHelpers } from '../test/domHelpers';

installObsidianDomHelpers();

function fakeRenderer(): ChatRenderer {
  return {} as ChatRenderer;
}

describe('SessionRuntime', () => {
  it('carries the session pointer on ChatState, the single source of truth', () => {
    const rt = new SessionRuntime('tab-1', 'ses-a', fakeRenderer());

    expect(rt.state.sessionId).toBe('ses-a');
    rt.sessionId = 'ses-b';
    expect(rt.state.sessionId).toBe('ses-b');
    rt.state.sessionId = null;
    expect(rt.sessionId).toBeNull();
  });

  it('starts with an idle, painted-clean transcript and no pending work', () => {
    const rt = new SessionRuntime('tab-1', null, fakeRenderer());

    expect(rt.busy).toBe(false);
    expect(rt.genId).toBe(0);
    expect(rt.promptQueue).toEqual([]);
    expect(rt.pendingRetry).toBeNull();
    expect(rt.painted).toBe(false);
    expect(rt.unread).toBe(false);
    expect(rt.capacityParked).toBe(false);
  });

  it('keeps turn state isolated between tabs', () => {
    const a = new SessionRuntime('tab-a', 'ses-a', fakeRenderer());
    const b = new SessionRuntime('tab-b', 'ses-b', fakeRenderer());

    a.busy = true;
    a.genId = 3;
    a.sendStartTime = 1234;
    a.promptQueue.push({ text: 'queued for A', refs: [] });
    a.pendingRetry = { text: 'retry A', imageParts: [] };
    a.unread = true;
    a.state.isStreaming = true;
    a.state.currentModelId = 'model-a';

    expect(b.busy).toBe(false);
    expect(b.genId).toBe(0);
    expect(b.sendStartTime).toBe(0);
    expect(b.promptQueue).toEqual([]);
    expect(b.pendingRetry).toBeNull();
    expect(b.unread).toBe(false);
    expect(b.state.isStreaming).toBe(false);
    expect(b.state.currentModelId).toBeNull();
  });

  it('owns a distinct state and renderer instance per tab', () => {
    const rendererA = fakeRenderer();
    const a = new SessionRuntime('tab-a', 'ses-a', rendererA);
    const b = new SessionRuntime('tab-b', 'ses-a', fakeRenderer());

    // The same agent session may back two tabs; the runtime never shares slots.
    expect(a.state).not.toBe(b.state);
    expect(a.renderer).toBe(rendererA);
    expect(b.renderer).not.toBe(a.renderer);
    expect(a.tabId).toBe('tab-a');
  });
});
