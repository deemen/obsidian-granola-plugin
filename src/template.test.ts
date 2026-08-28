import { describe, it, expect } from "vitest";
import {
	applyTemplate,
	sanitizeFilename,
	generateFilename,
	getFolderBasePath,
	resolveDatePattern,
	resolveNotePath,
} from "./template";
import type { MeetingData } from "./response-parser";

function meeting(overrides: Partial<MeetingData> = {}): MeetingData {
	return {
		id: "abc12345def",
		title: "Weekly Sync",
		date: "2026-03-03",
		startTime: "3:00 PM",
		created: "2026-03-03T15:00:00.000Z",
		url: "https://notes.granola.ai/d/abc12345def",
		privateNotes: "",
		enhancedNotes: "",
		transcript: "",
		participants: [],
		...overrides,
	};
}

describe("applyTemplate", () => {
	it("substitutes simple variables", () => {
		const result = applyTemplate("# {{granola_title}} on {{granola_date}}", meeting());
		expect(result).toBe("# Weekly Sync on 2026-03-03");
	});

	it("leaves unknown variables untouched", () => {
		expect(applyTemplate("{{not_a_var}}", meeting())).toBe("{{not_a_var}}");
	});

	it("renders conditional block when the variable is non-empty", () => {
		const tpl = "{{#granola_private_notes}}Notes: {{granola_private_notes}}{{/granola_private_notes}}";
		const result = applyTemplate(tpl, meeting({ privateNotes: "secret" }));
		expect(result).toBe("Notes: secret");
	});

	it("drops conditional block when the variable is empty", () => {
		const tpl = "before{{#granola_private_notes}}Notes{{/granola_private_notes}}after";
		expect(applyTemplate(tpl, meeting({ privateNotes: "" }))).toBe("beforeafter");
	});

	it("resolves attendee names, preferring vault note matches by email", () => {
		const m = meeting({
			participants: [
				{ name: "Jane Doe", email: "jane@example.com", organization: "Example Co", isCreator: true },
				{ name: "Outside Person", email: "out@other.com", organization: "Other", isCreator: false },
			],
		});
		const emailToNote = new Map([["jane@example.com", "Jane Doe (Person)"]]);
		const result = applyTemplate("{{granola_attendees_linked}}", m, emailToNote);
		expect(result).toBe("[[Jane Doe (Person)]], [[Outside Person]]");
	});

	it("formats the attendee list variants", () => {
		const m = meeting({
			participants: [
				{ name: "Alice", email: "a@x.com", organization: "", isCreator: false },
				{ name: "Bob", email: "b@x.com", organization: "", isCreator: false },
			],
		});
		expect(applyTemplate("{{granola_attendees}}", m)).toBe("Alice, Bob");
		expect(applyTemplate("{{granola_attendees_list}}", m)).toBe("  - Alice\n  - Bob");
		expect(applyTemplate("{{granola_attendees_linked_list}}", m)).toBe('  - "[[Alice]]"\n  - "[[Bob]]"');
	});
});

describe("sanitizeFilename", () => {
	it("replaces filesystem-unsafe characters with hyphens", () => {
		expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe("a-b-c-d-e-f-g-h-i-j");
	});

	it("truncates to 100 characters", () => {
		expect(sanitizeFilename("x".repeat(150))).toHaveLength(100);
	});

	it("replaces characters that would break a wikilink to the note", () => {
		expect(sanitizeFilename("Q3 [draft] #planning ^v2")).toBe("Q3 -draft- -planning -v2");
	});

	it("folds control characters into spaces", () => {
		expect(sanitizeFilename("Weekly Sync\n")).toBe("Weekly Sync");
		expect(sanitizeFilename("Weekly\tSync")).toBe("Weekly Sync");
		expect(sanitizeFilename("Weekly\r\nSync")).toBe("Weekly Sync");
	});

	it("collapses runs of whitespace", () => {
		expect(sanitizeFilename("Weekly   Sync")).toBe("Weekly Sync");
	});

	it("strips leading and trailing spaces and dots", () => {
		expect(sanitizeFilename("  Weekly Sync  ")).toBe("Weekly Sync");
		expect(sanitizeFilename("Weekly Sync...")).toBe("Weekly Sync");
		expect(sanitizeFilename(".hidden")).toBe("hidden");
	});

	it("does not split a surrogate pair at the truncation boundary", () => {
		const title = "x".repeat(99) + "\u{1F600}";
		expect(sanitizeFilename(title)).toBe(title);
	});

	it("falls back to a placeholder when nothing survives", () => {
		expect(sanitizeFilename("")).toBe("Untitled");
		expect(sanitizeFilename("   ")).toBe("Untitled");
		expect(sanitizeFilename("...")).toBe("Untitled");
	});

	it("falls back to a placeholder when a title is entirely unsafe characters", () => {
		expect(sanitizeFilename("???")).toBe("Untitled");
		expect(sanitizeFilename("###")).toBe("Untitled");
		expect(sanitizeFilename("[[]]")).toBe("Untitled");
		expect(sanitizeFilename("//")).toBe("Untitled");
	});

	it("trims hyphens at the edges without collapsing them inside", () => {
		expect(sanitizeFilename("-Weekly Sync-")).toBe("Weekly Sync");
		expect(sanitizeFilename("Q1/Q2")).toBe("Q1-Q2");
		expect(sanitizeFilename("Q1 // Q2")).toBe("Q1 -- Q2");
	});

	it("drops zero-width characters that would break a wikilink", () => {
		expect(sanitizeFilename("Weekly\u200BSync")).toBe("WeeklySync");
		expect(sanitizeFilename("Weekly Sync\u200B")).toBe("Weekly Sync");
		expect(sanitizeFilename("Weekly\u00ADSync")).toBe("WeeklySync");
		expect(sanitizeFilename("Weekly\u202ESync")).toBe("WeeklySync");
	});

	it("keeps a zero-width joiner so multi-part emoji survive intact", () => {
		const title = "Standup \u{1F469}\u200D\u{1F4BB}";
		expect(sanitizeFilename(title)).toBe(title);
	});
});

describe("resolveDatePattern", () => {
	it("expands date format tokens in folder paths", () => {
		expect(resolveDatePattern("Granola/{date:YYYY/MM/DD}", "2026-03-03")).toBe("Granola/2026/03/03");
		expect(resolveDatePattern("Granola/{date:YY/M/D}", "2026-03-03")).toBe("Granola/26/3/3");
		expect(resolveDatePattern("Granola/{date:MMMM}/{date:MMM}", "2026-03-03")).toBe("Granola/March/Mar");
	});

	it("expands {date} without a format as ISO date", () => {
		expect(resolveDatePattern("Granola/{date}", "2026-03-03")).toBe("Granola/2026-03-03");
	});

	it("leaves unknown folder path placeholders untouched", () => {
		expect(resolveDatePattern("Granola/{date:YYYY}/{unknown}", "2026-03-03")).toBe("Granola/2026/{unknown}");
	});

	it("expands a date it cannot parse to nothing rather than to \"Invalid date\"", () => {
		// parseGranolaDate hands back "" for a date string it could not read.
		expect(resolveDatePattern("Granola/{date:YYYY/MM}", "")).toBe("Granola/");
		expect(resolveDatePattern("Granola/{date:YYYY}", "whenever")).toBe("Granola/whenever");
	});
});

describe("getFolderBasePath", () => {
	it("returns the static prefix before the first date token", () => {
		expect(getFolderBasePath("Granola/{date:YYYY/MM/DD}")).toBe("Granola");
		expect(getFolderBasePath("Granola/Meetings/{date}")).toBe("Granola/Meetings");
	});

	it("returns the whole path when no date tokens are present", () => {
		expect(getFolderBasePath("Meetings")).toBe("Meetings");
	});

	it("returns nothing when the pattern is all date tokens", () => {
		expect(getFolderBasePath("{date:YYYY/MM}")).toBe("");
	});

	it("drops a trailing slash", () => {
		expect(getFolderBasePath("Meetings/")).toBe("Meetings");
		expect(getFolderBasePath("Meetings//{date}")).toBe("Meetings");
	});
});

describe("generateFilename", () => {
	it("expands the date, title, and id placeholders", () => {
		expect(generateFilename("{date} {title}", meeting())).toBe("2026-03-03 Weekly Sync");
		expect(generateFilename("{id}-{title}", meeting())).toBe("abc12345-Weekly Sync");
	});

	it("expands formatted date placeholders", () => {
		expect(generateFilename("{date:YYYY-MM}", meeting())).toBe("2026-03");
		expect(generateFilename("{date:YY-M-D}", meeting())).toBe("26-3-3");
		expect(generateFilename("{date:MMMM}-{date:MMM}", meeting())).toBe("March-Mar");
	});

	it("never lets a filename become a path", () => {
		// Subfolders are the folder setting's job; a separator here is just a name.
		expect(generateFilename("{date:YYYY/MM/DD} {title}", meeting())).toBe("2026-03-03 Weekly Sync");
		expect(generateFilename("{date}/{title}", meeting())).toBe("2026-03-03-Weekly Sync");
		expect(generateFilename("a:b|c", meeting())).toBe("a-b-c");
	});

	it("expands repeated placeholders", () => {
		expect(generateFilename("{date} {date} {title} {title} {id} {id}", meeting())).toBe(
			"2026-03-03 2026-03-03 Weekly Sync Weekly Sync abc12345 abc12345",
		);
	});

	it("leaves unknown filename placeholders untouched", () => {
		expect(generateFilename("{date} {unknown} {title}", meeting())).toBe("2026-03-03 {unknown} Weekly Sync");
	});

	it("expands a date it cannot parse to nothing rather than to \"Invalid date\"", () => {
		expect(generateFilename("{date:YYYY-MM} {title}", meeting({ date: "" }))).toBe(" Weekly Sync");
	});

	it("sanitizes the title within the filename", () => {
		expect(generateFilename("{title}", meeting({ title: "Q1/Q2 Review" }))).toBe("Q1-Q2 Review");
	});

	it("keeps $ replacement patterns in the title literal", () => {
		expect(generateFilename("{title}", meeting({ title: "Q3 $& Q4" }))).toBe("Q3 $& Q4");
		expect(generateFilename("{title}", meeting({ title: "Q3 $` Q4" }))).toBe("Q3 $` Q4");
		expect(generateFilename("{title}", meeting({ title: "Q3 $' Q4" }))).toBe("Q3 $' Q4");
	});

	it("does not re-expand a placeholder that came from the title", () => {
		expect(generateFilename("{title}", meeting({ title: "Ticket {id} review" }))).toBe(
			"Ticket {id} review",
		);
	});

	it("expands every occurrence of a placeholder", () => {
		expect(generateFilename("{date} {date}", meeting())).toBe("2026-03-03 2026-03-03");
	});
});

describe("resolveNotePath", () => {
	const build = (folderPattern: string) => resolveNotePath(folderPattern, "{date} {title}", meeting());

	it("files a note under the folder pattern", () => {
		expect(build("Meetings")).toEqual({
			folder: "Meetings",
			path: "Meetings/2026-03-03 Weekly Sync.md",
		});
	});

	it("ignores slashes around the folder setting", () => {
		for (const setting of ["Meetings/", "/Meetings", "/Meetings/", "Meetings//"]) {
			expect(build(setting)).toEqual(build("Meetings"));
		}
	});

	it("files at the vault root when the folder path is a bare slash", () => {
		expect(build("/").path).toBe("2026-03-03 Weekly Sync.md");
	});

	it("expands date tokens into the folder, not the filename", () => {
		expect(build("Meetings/{date:YYYY/MM}")).toEqual({
			folder: "Meetings/2026/03",
			path: "Meetings/2026/03/2026-03-03 Weekly Sync.md",
		});
	});

	it("keeps an undated meeting in the base folder", () => {
		expect(resolveNotePath("Meetings/{date:YYYY/MM}", "{title}", meeting({ date: "" }))).toEqual({
			folder: "Meetings",
			path: "Meetings/Weekly Sync.md",
		});
	});
});
