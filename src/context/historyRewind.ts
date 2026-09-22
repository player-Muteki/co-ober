import type { SerializedMessage } from '../types';
import { t } from '../i18n/index';

/**
 * Render the retained part of a conversation as a single text block so a fresh
 * agent session keeps the context a rewind dropped from its own history.
 */
export function buildHistoryBlock(messages: SerializedMessage[]): string | undefined {
  const lines = messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.type === 'text'
      && (m.content.trim().length > 0 || (m.role === 'user' && !!m.images?.length)))
    .map((m) => {
      const imageNote = m.images?.length
        ? ` [+${m.images.length} image${m.images.length > 1 ? 's' : ''} not included]`
        : '';
      return `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.trim()}${imageNote}`;
    });
  if (lines.length === 0) return undefined;
  return [t().rewind.contextHeader, lines.join('\n\n'), t().rewind.contextFooter].join('\n\n');
}
