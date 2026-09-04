import { describe, it, expect } from "vitest";
import { buildListMeetingsArgs } from "./mcp-client";

describe("buildListMeetingsArgs", () => {
	it("asks for meetings the user captured or participated in", () => {
		expect(buildListMeetingsArgs("last_30_days", true)).toEqual({
			time_range: "last_30_days",
			involvement: { captured_by_me: true, listed_as_participant: true },
		});
	});

	it("omits the involvement filter when syncing every visible meeting", () => {
		expect(buildListMeetingsArgs("this_week", false)).toEqual({ time_range: "this_week" });
	});

	it("never sends workspace_only, which would exclude private meetings", () => {
		expect(buildListMeetingsArgs("last_week", true)).not.toHaveProperty("workspace_only");
		expect(buildListMeetingsArgs("last_week", false)).not.toHaveProperty("workspace_only");
	});

	it("builds custom date ranges for last_90_days", () => {
		const fixedDate = new Date(2026, 2, 15, 12, 0, 0); // Mar 15, 2026
		const args = buildListMeetingsArgs("last_90_days", true, fixedDate);
		expect(args).toEqual({
			time_range: "custom",
			custom_start: "2025-12-15",
			custom_end: "2026-03-15",
			involvement: { captured_by_me: true, listed_as_participant: true },
		});
	});

	it("builds custom date ranges for last_180_days", () => {
		const fixedDate = new Date(2026, 2, 15, 12, 0, 0); // Mar 15, 2026
		const args = buildListMeetingsArgs("last_180_days", false, fixedDate);
		expect(args).toEqual({
			time_range: "custom",
			custom_start: "2025-09-16",
			custom_end: "2026-03-15",
		});
	});

	it("builds custom date ranges for last_1_year", () => {
		const fixedDate = new Date(2026, 2, 15, 12, 0, 0); // Mar 15, 2026
		const args = buildListMeetingsArgs("last_1_year", true, fixedDate);
		expect(args).toEqual({
			time_range: "custom",
			custom_start: "2025-03-15",
			custom_end: "2026-03-15",
			involvement: { captured_by_me: true, listed_as_participant: true },
		});
	});

	it("builds custom date ranges for all_time starting at 2020-01-01", () => {
		const fixedDate = new Date(2026, 2, 15, 12, 0, 0); // Mar 15, 2026
		const args = buildListMeetingsArgs("all_time", true, fixedDate);
		expect(args).toEqual({
			time_range: "custom",
			custom_start: "2020-01-01",
			custom_end: "2026-03-15",
			involvement: { captured_by_me: true, listed_as_participant: true },
		});
	});
});
