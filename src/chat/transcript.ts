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
	if (cleaned.length === 0) return 'chat';
	// The 80-unit cut is a code-unit boundary, so a title whose 80th unit is the
	// first half of a pair (an emoji, most CJK outside the BMP) leaves a lone
	// high surrogate in the filename — a name no note can be read back from.
	// Drop the orphan rather than shorten the ceiling: the reader loses one
	// glyph they could not have typed into the name anyway.
	return cleaned.slice(0, 80).replace(/[\uD800-\uDBFF]$/, '');
}
