import type { CopsidianSettings, SessionConfigOption } from '../types';

export interface DefaultSessionClient {
  setMode(sessionId: string, modeId: string): Promise<void>;
  setModel(sessionId: string, modelId: string): Promise<void>;
  setConfigOption(sessionId: string, configId: string, value: string): Promise<SessionConfigOption[]>;
}

export async function applyDefaultSessionSettings(
  client: DefaultSessionClient,
  sessionId: string,
  settings: CopsidianSettings,
): Promise<void> {
  if (settings.defaultAgent) await client.setMode(sessionId, settings.defaultAgent);
  if (settings.defaultModel) await client.setModel(sessionId, settings.defaultModel);
  if (settings.defaultEffort && settings.defaultEffort !== 'default') {
    await client.setConfigOption(sessionId, 'effort', settings.defaultEffort);
  }
}
