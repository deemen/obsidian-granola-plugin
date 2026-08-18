import { App, normalizePath, TFile } from "obsidian";
import type { MeetingData, ParsedParticipant } from "./response-parser";
import DEFAULT_TEMPLATE from "./default-template.md";

export async function loadTemplate(app: App, templatePath: string): Promise<string> {
	const normalizedPath = normalizePath(templatePath);
	const file = app.vault.getAbstractFileByPath(normalizedPath);

	if (file instanceof TFile) {
		return await app.vault.read(file);
	}

	// Create default template if it doesn't exist
	const lastSlash = normalizedPath.lastIndexOf("/");
	if (lastSlash > 0) {
		const folderPath = normalizedPath.substring(0, lastSlash);
		const folder = app.vault.getAbstractFileByPath(folderPath);
		if (!folder) {
			await app.vault.createFolder(folderPath);
		}
	}
	await app.vault.create(normalizedPath, DEFAULT_TEMPLATE);
	return DEFAULT_TEMPLATE;
}

function resolveParticipantName(
	participant: ParsedParticipant,
	emailToNoteTitle: Map<string, string>,
): string | null {
	// First, try to match by email to an existing note
	if (participant.email) {
		const noteTitle = emailToNoteTitle.get(participant.email.toLowerCase());
		if (noteTitle) return noteTitle;
	}

	return participant.name || participant.email || null;
}

export function applyTemplate(
	template: string,
	meeting: MeetingData,
	emailToNoteTitle: Map<string, string> = new Map(),
): string {
	// Resolve attendee names, preferring matches from vault notes
	const attendeeNames = meeting.participants
		.map((p) => resolveParticipantName(p, emailToNoteTitle))
		.filter((name): name is string => name !== null);

	const variables: Record<string, string> = {
		granola_id: meeting.id,
		granola_title: meeting.title,
		granola_date: meeting.date,
		granola_created: meeting.created,
		granola_updated: "",
		granola_private_notes: meeting.privateNotes,
		granola_enhanced_notes: meeting.enhancedNotes,
		granola_transcript: meeting.transcript,
		granola_attendees: attendeeNames.join(", "),
		granola_attendees_linked: attendeeNames.map((name) => `[[${name}]]`).join(", "),
		granola_attendees_list: attendeeNames.map((name) => `  - ${name}`).join("\n"),
		granola_attendees_linked_list: attendeeNames
			.map((name) => `  - "[[${name}]]"`)
			.join("\n"),
		granola_url: meeting.url,
		granola_duration: "",
		granola_start_time: meeting.startTime,
		granola_end_time: "",
	};

	// Process conditional blocks: {{#var}}content{{/var}} - only renders if var is non-empty
	let result = template.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key: string, content: string) => {
		const value = variables[key];
		return value?.trim() ? content : "";
	});

	// Replace simple variables: {{var}}
	result = result.replace(/\{\{(\w+)\}\}/g, (_, key: string) => variables[key] ?? `{{${key}}}`);

	return result;
}

/** Characters no filename may contain on Windows or macOS. */
const UNSAFE_FILENAME_CHARS = /[/\\?%*:|"<>]/g;

/**
 * C0 and C1 control characters. Titles copied out of a multi-line calendar
 * invite arrive with the newline still attached, and a newline is not a
 * filesystem-unsafe character, so it used to survive into the filename.
 */
const CONTROL_CHARS = /\p{Cc}/gu;

const MAX_FILENAME_LENGTH = 100;

/**
 * Turn a meeting title into a filename component.
 *
 * Granola titles come straight from calendar events, so they carry whatever the
 * organizer typed: a trailing newline, a stray tab, an emoji, or nothing but
 * punctuation. Control characters are folded into spaces and runs of whitespace
 * collapsed, because a filename containing a raw newline is legal on macOS but
 * unusable everywhere else.
 *
 * Truncation counts code points rather than UTF-16 units: `String.slice` cuts an
 * emoji in half at the boundary and leaves a lone surrogate in the name. Trailing
 * spaces and dots are stripped after the cut rather than before, so truncation
 * cannot reintroduce one — Windows rejects both, and a leading dot would hide the
 * note. A title that is entirely unsafe characters would otherwise reduce to a row
 * of hyphens, so an empty result falls back to "Untitled".
 */
export function sanitizeFilename(name: string): string {
	const cleaned = name
		.replace(CONTROL_CHARS, " ")
		.replace(UNSAFE_FILENAME_CHARS, "-")
		.replace(/\s+/g, " ")
		.trim();

	const truncated = Array.from(cleaned).slice(0, MAX_FILENAME_LENGTH).join("");

	return truncated
		.replace(/^\.+/, "")
		.replace(/[ .]+$/, "")
		.trim() || "Untitled";
}

/**
 * Expand `{date}`, `{title}` and `{id}` in the user's filename pattern.
 *
 * One regex pass with a replacer function, rather than three chained
 * `String.replace(string, string)` calls. Those interpret `$&`, `` $` `` and `$'`
 * inside the *replacement*, so a meeting titled "Q3 $& Q4" expanded to the text
 * the pattern had just matched instead of to the title. Substituting in a single
 * pass also stops an expanded value from being rescanned: a title containing the
 * literal "{id}" used to have it replaced by the meeting id.
 */
export function generateFilename(pattern: string, meeting: MeetingData): string {
	const values: Record<string, string> = {
		date: meeting.date,
		title: sanitizeFilename(meeting.title),
		id: meeting.id.slice(0, 8),
	};

	return pattern.replace(/\{(date|title|id)\}/g, (_, token: string) => values[token]);
}
