import type { AgentCapabilities } from '../types';

/**
 * ACP defaults every prompt capability to false, so an agent that told us what
 * it can do without naming this one has said it cannot take it. An agent that
 * never reported capabilities at all predates the handshake, and there silence
 * means "unknown" rather than "no".
 */
export function supportsPromptCapability(
  caps: AgentCapabilities | null | undefined,
  key: 'audio' | 'embeddedContext' | 'image',
): boolean {
  if (!caps) return true;
  return caps.promptCapabilities?.[key] === true;
}
