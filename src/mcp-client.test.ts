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
});
