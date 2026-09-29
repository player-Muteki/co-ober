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
	const blocks = msg.contentBlocks ?? [];
	// An agent image lands in the transcript as an image content block, with the
	// message's own content left empty — so a turn that showed a picture beside
	// the answer carried nothing into the export this function was skipping.
	const imageCount = (msg.images?.length ?? 0) + blocks.filter((block) => block.type === 'image').length;
	if (imageCount > 0) parts.push(Array(imageCount).fill(t().transcript.image).join(' '));
	// The steps a turn took are on screen as cards; a turn that answered in tool
	// calls alone was a card list the exported note threw away whole.
	const steps = blocks
		.filter((block) => block.type === 'tool_use')
		.map((block) => block.toolTitle?.trim() ?? '')
		.filter(Boolean);
	if (steps.length > 0) parts.push(steps.map((step) => `${t().transcript.tool} ${step}`).join('\n'));
	return parts.join('\n\n');
}

/** Render a stored session as a Markdown transcript for export or clipboard copy. */
export function buildTranscriptMarkdown(session: SerializedSession): string {
	const lines: string[] = [`# ${session.title}`, ''];
	for (const msg of session.messages) {
		if (msg.type !== 'text' && msg.type !== 'tool-call') continue;
		const body = messageBody(msg);
		if (!body) continue;
		// A message whose time is not known says so by saying nothing. The loader
		// collapses a damaged timestamp to 0 (pluginDataMigration.ts), and 0 is a
		// readable epoch — so an unread turn would be dated to 1970 in the exported
		// note rather than left without a time.
		const role = ROLE_LABELS[msg.role]();
		lines.push(msg.timestamp > 0 ? `## ${role} · ${formatTimestamp(msg.timestamp)}` : `## ${role}`, '', body, '');
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
