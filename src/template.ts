import { App, moment, normalizePath, TFile } from "obsidian";
import type { MeetingData, ParsedParticipant } from "./response-parser";
import DEFAULT_TEMPLATE from "./default-template.md";

export async function loadTemplate(
	app: App,
	templatePath: string,
	defaultContent: string = DEFAULT_TEMPLATE,
): Promise<string> {
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
	await app.vault.create(normalizedPath, defaultContent);
	return defaultContent;
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
	extraVariables: Record<string, string> = {},
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
		granola_folder: meeting.folder ?? "",
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
		granola_meeting_note: extraVariables.granola_meeting_note ?? "",
		granola_meeting_link:
			extraVariables.granola_meeting_link ??
			(extraVariables.granola_meeting_note ? `[[${extraVariables.granola_meeting_note}]]` : ""),
		granola_meeting_transcript: extraVariables.granola_meeting_transcript ?? "",
		granola_meeting_transcript_link:
			extraVariables.granola_meeting_transcript_link ??
			(extraVariables.granola_meeting_transcript
				? `[[${extraVariables.granola_meeting_transcript}]]`
				: ""),
		// Legacy / alternative aliases
		granola_transcript_note: extraVariables.granola_meeting_transcript ?? "",
		granola_transcript_link: extraVariables.granola_meeting_transcript
			? `[[${extraVariables.granola_meeting_transcript}]]`
			: "",
		...extraVariables,
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

/** A `{date}` or `{meeting_date}` placeholder, optionally carrying a moment format: `{date:YYYY/MM}`. */
const DATE_TOKEN = /\{(?:date|meeting_date)(?::([^}]+))?\}/g;

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
 * Expand `{date}` / `{meeting_date}` / `{date:FORMAT}` in a folder path, so meetings can be filed
 * into dated subfolders like `Meetings/{date:YYYY/MM}`. Slashes in the result are
 * meaningful here — they are what creates the nesting.
 */
export function resolveDatePattern(pattern: string, date: string): string {
	return pattern.replace(DATE_TOKEN, (_, format: string | undefined) =>
		format ? formatMeetingDate(date, format) : date,
	);
}

/**
 * The fixed leading part of a folder pattern, before any dynamic token — the folder
 * every dated subfolder lives under. Created up front so a sync still has a home
 * folder to report against before any meeting has been placed.
 */
export function getFolderBasePath(folderPattern: string): string {
	// split returns the whole string as one element when there is no dynamic token.
	return folderPattern.split(/\{[^}]+\}/)[0].replace(/\/+$/, "");
}

/**
 * Sanitize a folder segment or path string for folder creation.
 * Preserves slashes for hierarchy, but sanitizes each segment with sanitizeFilename.
 */
export function sanitizeFolderPath(pathStr: string): string {
	return pathStr
		.split(/[\\/]+/)
		.map((seg) => sanitizeFilename(seg))
		.filter((seg) => seg && seg !== "Untitled")
		.join("/");
}

/**
 * Expand `{date}`, `{meeting_date}`, `{date:FORMAT}`, `{title}`, `{meeting_name}`, `{id}`,
 * `{granolaFolder}`, `{folder}`, and any extra tokens (e.g. `{meeting_filename}`, `{filename}`)
 * in the user's filename pattern.
 *
 * The result is a file *name*, never a path: a separator surviving from a format
 * like `{date:YYYY/MM}`, or typed into the pattern directly, is folded to a hyphen
 * rather than quietly nesting the note. Subfolders are the folder setting's job,
 * which takes the same date tokens.
 */
export function generateFilename(
	pattern: string,
	meeting: MeetingData,
	extraTokens: Record<string, string> = {},
): string {
	const sanitizedTitle = sanitizeFilename(meeting.title);
	const sanitizedFolder = meeting.folder ? sanitizeFilename(meeting.folder) : "";

	const values: Record<string, string> = {
		title: sanitizedTitle,
		meeting_name: sanitizedTitle,
		id: meeting.id.slice(0, 8),
		folder: sanitizedFolder,
		granolaFolder: sanitizedFolder,
		...Object.fromEntries(
			Object.entries(extraTokens).map(([k, v]) => [k, sanitizeFilename(v)]),
		),
	};

	const tokenKeys = Object.keys(values).join("|");
	const tokenRegex = new RegExp(`\\{(${tokenKeys})\\}`, "g");

	return resolveDatePattern(pattern, meeting.date)
		.replace(tokenRegex, (_, token: string) => values[token] ?? "")
		.replace(UNSAFE_FILENAME_CHARS, "-");
}

/**
 * Expand dynamic tokens in a folder path pattern. Slashes in the result create nesting.
 */
export function resolveFolderPath(
	folderPattern: string,
	meeting: MeetingData,
	extraTokens: Record<string, string> = {},
): string {
	const sanitizedFolder = meeting.folder ? sanitizeFolderPath(meeting.folder) : "";
	const sanitizedTitle = sanitizeFilename(meeting.title);

	const values: Record<string, string> = {
		title: sanitizedTitle,
		meeting_name: sanitizedTitle,
		id: meeting.id.slice(0, 8),
		folder: sanitizedFolder,
		granolaFolder: sanitizedFolder,
		meeting_folder: extraTokens.meeting_folder ? normalizePath(extraTokens.meeting_folder) : "",
		...extraTokens,
	};

	const tokenKeys = Object.keys(values).join("|");
	const tokenRegex = new RegExp(`\\{(${tokenKeys})\\}`, "g");

	const expanded = resolveDatePattern(folderPattern, meeting.date).replace(
		tokenRegex,
		(_, token: string) => values[token] ?? "",
	);

	return normalizePath(expanded);
}

/**
 * Where a meeting's note belongs: the folder to create, filename, and the note's full path.
 *
 * Both come back from one place because they have to agree — the path is built by
 * joining the folder to the filename, and `normalizePath` is what reconciles the
 * separators, dropping a trailing slash the user typed and collapsing the one this
 * join adds. A folder setting of "Meetings/" therefore behaves exactly like
 * "Meetings", and a setting of "/" files notes at the vault root.
 */
export function resolveNotePath(
	folderPattern: string,
	filenamePattern: string,
	meeting: MeetingData,
): { folder: string; filename: string; path: string } {
	const folder = resolveFolderPath(folderPattern, meeting);
	const filename = generateFilename(filenamePattern, meeting);
	const path = folder === "/" || folder === "" ? `${filename}.md` : normalizePath(`${folder}/${filename}.md`);
	return { folder, filename, path };
}

/**
 * Where a meeting's transcript note belongs. Supports `{meeting_folder}` and `{meeting_filename}`/`{filename}`.
 */
export function resolveTranscriptPath(
	transcriptFolderPattern: string,
	transcriptFilenamePattern: string,
	meeting: MeetingData,
	meetingFolder: string,
	meetingFilename: string,
): { folder: string; filename: string; path: string } {
	const extraTokens: Record<string, string> = {
		meeting_folder: meetingFolder,
		meeting_filename: meetingFilename,
		filename: meetingFilename,
	};
	const folder = resolveFolderPath(transcriptFolderPattern, meeting, extraTokens);
	const filename = generateFilename(transcriptFilenamePattern, meeting, extraTokens);
	const path = folder === "/" || folder === "" ? `${filename}.md` : normalizePath(`${folder}/${filename}.md`);
	return { folder, filename, path };
}
