import { describe, it, expect } from "vitest";
import { syncFolderFirst } from "./note-scope";

const paths = (files: { path: string }[]) => files.map((f) => f.path);

describe("syncFolderFirst", () => {
	it("puts sync folder notes first and keeps the rest", () => {
		const vault = [
			{ path: "Projects/apollo.md" },
			{ path: "Meetings/weekly.md" },
			{ path: "top-level.md" },
			{ path: "Meetings/2026/q1.md" },
		];
		expect(paths(syncFolderFirst(vault, "Meetings"))).toEqual([
			"Meetings/weekly.md",
			"Meetings/2026/q1.md",
			"Projects/apollo.md",
			"top-level.md",
		]);
	});

	it("does not treat a longer sibling folder as the sync folder", () => {
		const vault = [{ path: "Meetings Archive/old.md" }, { path: "Meetings/weekly.md" }];
		expect(paths(syncFolderFirst(vault, "Meetings"))).toEqual([
			"Meetings/weekly.md",
			"Meetings Archive/old.md",
		]);
	});

	it("returns every note even when the sync folder is empty", () => {
		const vault = [{ path: "Projects/apollo.md" }, { path: "top-level.md" }];
		expect(paths(syncFolderFirst(vault, "Meetings"))).toEqual([
			"Projects/apollo.md",
			"top-level.md",
		]);
	});
});
