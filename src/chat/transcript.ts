import { t } from '../i18n/index';
import type { SerializedMessage, SerializedSession } from '../types';

const ROLE_LABELS: Record<SerializedMessage['role'], () => string> = {
	user: () => t().transcript.user,
	assistant: () => t().transcript.assistant,
	system: () => t().transcript.system,
};

function formatTimestamp(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function messageBody(msg: SerializedMessage): string {
	const parts: string[] = [];
	if (msg.content) parts.push(msg.content);
	const imageCount = msg.images?.length ?? 0;
	if (imageCount > 0) parts.push(Array(imageCount).fill(t().transcript.image).join(' '));
	return parts.join('\n\n');
}

/** Render a stored session as a Markdown transcript for export or clipboard copy. */
export function buildTranscriptMarkdown(session: SerializedSession): string {
	const lines: string[] = [`# ${session.title}`, ''];
	for (const msg of session.messages) {
		if (msg.type !== 'text') continue;
		const body = messageBody(msg);
		if (!body) continue;
		lines.push(`## ${ROLE_LABELS[msg.role]()} · ${formatTimestamp(msg.timestamp)}`, '', body, '');
	}
	return lines.join('\n').trimEnd() + '\n';
}

/** Session title sanitized for use as a vault note filename. */
export function sanitizeNoteName(title: string): string {
	const cleaned = title
		.replace(/[\\/:*?"<>|#^[\]]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return cleaned.length > 0 ? cleaned.slice(0, 80) : 'chat';
}
