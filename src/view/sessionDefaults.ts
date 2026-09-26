import { t } from '../i18n/index';
import type { CoOberSettings, SessionConfigOption } from '../types';

export interface DefaultSessionClient {
  setMode(sessionId: string, modeId: string): Promise<void>;
  setModel(sessionId: string, modelId: string): Promise<void>;
  setConfigOption(sessionId: string, configId: string, value: string): Promise<SessionConfigOption[]>;
}

/**
 * A default is a request, not a precondition. An agent that does not offer the
 * effort option (or does not know the saved model id) used to fail the whole
 * session creation, so the reader was told the session could not be started
 * when in fact it was started and only a preference was refused. The names that
 * come back are the ones the transcript says so about.
 */
export async function applyDefaultSessionSettings(
  client: DefaultSessionClient,
  sessionId: string,
  settings: CoOberSettings,
): Promise<string[]> {
  const missed: string[] = [];
  const attempt = async (label: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch {
      missed.push(label);
    }
  };

  if (settings.defaultAgent) await attempt(t().settings.defaultAgent, () => client.setMode(sessionId, settings.defaultAgent));
  if (settings.defaultModel) await attempt(t().settings.defaultModel, () => client.setModel(sessionId, settings.defaultModel));
  if (settings.defaultEffort && settings.defaultEffort !== 'default') {
    await attempt(t().settings.defaultEffort.name, () => client.setConfigOption(sessionId, 'effort', settings.defaultEffort));
  }

  return missed;
}
