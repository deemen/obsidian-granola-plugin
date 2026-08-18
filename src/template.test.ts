import { describe, it, expect } from "vitest";
import { applyTemplate, sanitizeFilename, generateFilename } from "./template";
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
});

describe("generateFilename", () => {
	it("expands the date, title, and id placeholders", () => {
		expect(generateFilename("{date} {title}", meeting())).toBe("2026-03-03 Weekly Sync");
		expect(generateFilename("{id}-{title}", meeting())).toBe("abc12345-Weekly Sync");
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
