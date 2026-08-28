import { App, moment, normalizePath, TFile } from "obsidian";
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

/**
 * Zero-width format characters: the zero-width space, the soft hyphen, the bidi
 * marks and the BOM. They render as nothing, so a title carrying one looks
 * identical to one that doesn't and no [[wikilink]] a reader types by hand can
 * resolve — the same failure as a trailing space, just invisible in the file
 * explorer too. Dropped rather than folded into a space so the visible title is
 * unchanged. The zero-width joiner (U+200D) is excluded: it is what holds a
 * multi-part emoji together, and dropping it would split one glyph into several.
 */
const FORMAT_CHARS = /(?!\u200d)\p{Cf}/gu;

/**
 * Legal in a filename, but each one breaks an Obsidian [[wikilink]] pointing at
 * the note: `#` opens a heading reference, `^` a block reference, and `]]` closes
 * the link early. Meeting notes are linked from daily notes and MOCs, so a title
 * like "Q3 [draft] #planning" would otherwise produce a note nothing can link to.
 * (`|`, the alias separator, is already covered as a filesystem-unsafe character.)
 */
const WIKILINK_UNSAFE_CHARS = /[#^[\]]/g;

const MAX_FILENAME_LENGTH = 100;

/**
 * Turn a meeting title into a filename component.
 *
 * Granola titles come straight from calendar events, so they carry whatever the
 * organizer typed: a trailing newline, a stray tab, an emoji, or nothing but
 * punctuation. Control characters are folded into spaces and runs of whitespace
 * collapsed, because a filename containing a raw newline is legal on macOS but
 * unusable everywhere else; zero-width characters are dropped outright, since a
 * space in their place would show up in a name that looked fine before.
 *
 * Truncation counts code points rather than UTF-16 units: `String.slice` cuts an
 * emoji in half at the boundary and leaves a lone surrogate in the name. Trailing
 * spaces, dots and hyphens are stripped after the cut rather than before, so
 * truncation cannot reintroduce one — Windows rejects a trailing space or dot, and
 * a leading dot would hide the note. Hyphens are trimmed only at the edges, never
 * collapsed inside, so "Q1/Q2" stays "Q1-Q2". A title made entirely of unsafe
 * characters reduces to a row of hyphens and therefore to nothing, so it falls
 * back to "Untitled".
 */
export function sanitizeFilename(name: string): string {
	const cleaned = name
		.replace(CONTROL_CHARS, " ")
		.replace(FORMAT_CHARS, "")
		.replace(UNSAFE_FILENAME_CHARS, "-")
		.replace(WIKILINK_UNSAFE_CHARS, "-")
		.replace(/\s+/g, " ")
		.trim();

	const truncated = Array.from(cleaned).slice(0, MAX_FILENAME_LENGTH).join("");

	return truncated
		.replace(/^[.-]+/, "")
		.replace(/[ .-]+$/, "")
		.trim() || "Untitled";
}

/** A `{date}` placeholder, optionally carrying a moment format: `{date:YYYY/MM}`. */
const DATE_TOKEN = /\{date(?::([^}]+))?\}/g;

/**
 * Meeting dates arrive as ISO `YYYY-MM-DD` strings. Parse with an explicit input
 * format so moment never falls back to its ambiguous heuristics, then re-render
 * in whatever the user asked for. Obsidian bundles moment and re-exports it, so
 * the format tokens match the ones users already know from Obsidian's own date
 * settings.
 *
 * `utc` because a meeting date is a bare calendar date with no time or zone —
 * parsing it as local midnight would let a format like `{date:YYYY/MM}` land in
 * the previous month for anyone west of UTC.
 *
 * Parsing is strict, which is safe because `parseGranolaDate` always emits a
 * zero-padded `YYYY-MM-DD` — and it also gives us a usable invalid signal. That
 * matters: a meeting whose date Granola sends in a form `Date` cannot read comes
 * through as "", and `moment.format` renders any invalid date as the literal
 * "Invalid date". Falling back to the raw value instead means a formatted token
 * degrades exactly like a bare `{date}` does, so an undated meeting lands in the
 * base folder rather than in one named "Invalid date".
 */
function formatMeetingDate(date: string, format: string): string {
	const parsed = moment.utc(date, "YYYY-MM-DD", true);
	return parsed.isValid() ? parsed.format(format) : date;
}

/**
 * Expand `{date}` / `{date:FORMAT}` in a folder path, so meetings can be filed
 * into dated subfolders like `Meetings/{date:YYYY/MM}`. Slashes in the result are
 * meaningful here — they are what creates the nesting.
 */
export function resolveDatePattern(pattern: string, date: string): string {
	return pattern.replace(DATE_TOKEN, (_, format: string | undefined) =>
		format ? formatMeetingDate(date, format) : date,
	);
}

/**
 * The fixed leading part of a folder pattern, before any date token — the folder
 * every dated subfolder lives under. Created up front so a sync still has a home
 * folder to report against before any meeting has been placed.
 */
export function getFolderBasePath(folderPattern: string): string {
	// split returns the whole string as one element when there is no date token.
	return folderPattern.split(DATE_TOKEN)[0].replace(/\/+$/, "");
}

/**
 * Expand `{date}`, `{date:FORMAT}`, `{title}` and `{id}` in the user's filename
 * pattern.
 *
 * Both passes use a replacer function rather than `String.replace(string, string)`,
 * which interprets `$&`, `` $` `` and `$'` inside the *replacement* — a meeting
 * titled "Q3 $& Q4" used to expand to the text the pattern had just matched. Title
 * and id share one pass so an expanded value is never rescanned: a title containing
 * the literal "{id}" used to have it replaced by the meeting id.
 *
 * The result is a file *name*, never a path: a separator surviving from a format
 * like `{date:YYYY/MM}`, or typed into the pattern directly, is folded to a hyphen
 * rather than quietly nesting the note. Subfolders are the folder setting's job,
 * which takes the same date tokens.
 */
export function generateFilename(pattern: string, meeting: MeetingData): string {
	const values: Record<string, string> = {
		title: sanitizeFilename(meeting.title),
		id: meeting.id.slice(0, 8),
	};

	return resolveDatePattern(pattern, meeting.date)
		.replace(/\{(title|id)\}/g, (_, token: string) => values[token])
		.replace(UNSAFE_FILENAME_CHARS, "-");
}
