import { describe, it, expect } from 'vitest';
import { supportsPromptCapability } from './agentCapabilities';
import type { AgentCapabilities } from '../types';

const caps = (promptCapabilities?: Record<string, boolean>): AgentCapabilities =>
  ({ loadSession: true, ...(promptCapabilities ? { promptCapabilities } : {}) }) as AgentCapabilities;

describe('supportsPromptCapability', () => {
  it('reads a reported capability list as defaults, not as permission', () => {
    // ACP defaults every prompt capability to false, so an agent that answered
    // the handshake without naming `image` has answered "no" to images.
    expect(supportsPromptCapability(caps({ audio: false }), 'image')).toBe(false);
    expect(supportsPromptCapability(caps({}), 'embeddedContext')).toBe(false);
    expect(supportsPromptCapability(caps({ image: true }), 'image')).toBe(true);
  });

  it('denies a capability the agent turned off explicitly', () => {
    expect(supportsPromptCapability(caps({ image: false, embeddedContext: false, audio: false }), 'image')).toBe(false);
  });

  it('treats an agent that never reported capabilities as unknown', () => {
    // Pre-handshake agents answer nothing here; guessing "no" would take the
    // image attach away from a client that has always worked with them.
    expect(supportsPromptCapability(null, 'image')).toBe(true);
    expect(supportsPromptCapability(undefined, 'image')).toBe(true);
  });

  it('does not read a capability group this client does not model as granted', () => {
    expect(supportsPromptCapability(caps(), 'image')).toBe(false);
  });
});
