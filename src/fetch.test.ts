import { describe, it, expect } from "vitest";
import { parseRetryAfter, computeRetryDelay, BASE_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS } from "./fetch";

describe("parseRetryAfter", () => {
	it("returns null for empty or null header", () => {
		expect(parseRetryAfter(null)).toBeNull();
		expect(parseRetryAfter("")).toBeNull();
		expect(parseRetryAfter("   ")).toBeNull();
	});

	it("parses integer seconds into milliseconds", () => {
		expect(parseRetryAfter("10")).toBe(10000);
		expect(parseRetryAfter(" 60 ")).toBe(60000);
		expect(parseRetryAfter("0")).toBe(0);
	});

	it("parses valid HTTP-date", () => {
		const future = new Date(Date.now() + 5000);
		const result = parseRetryAfter(future.toUTCString());
		expect(result).not.toBeNull();
		expect(result!).toBeGreaterThan(0);
		expect(result!).toBeLessThanOrEqual(5500);
	});

	it("returns null for non-numeric, non-date string", () => {
		expect(parseRetryAfter("invalid-value")).toBeNull();
	});
});

describe("computeRetryDelay", () => {
	it("uses retry-after if provided with slight jitter", () => {
		const delay = computeRetryDelay(0, 5000, () => 0.5);
		expect(delay).toBe(5000 + 0.5 * 250);
	});

	it("uses exponential backoff when retry-after is not provided", () => {
		const delay0 = computeRetryDelay(0, null, () => 0);
		expect(delay0).toBe(BASE_RETRY_DELAY_MS); // 1500 * 2^0 = 1500

		const delay1 = computeRetryDelay(1, null, () => 0);
		expect(delay1).toBe(BASE_RETRY_DELAY_MS * 2); // 1500 * 2^1 = 3000

		const delay2 = computeRetryDelay(2, null, () => 0);
		expect(delay2).toBe(BASE_RETRY_DELAY_MS * 4); // 1500 * 2^2 = 6000
	});

	it("caps delay at MAX_RETRY_DELAY_MS", () => {
		const delay = computeRetryDelay(10, null, () => 0);
		expect(delay).toBe(MAX_RETRY_DELAY_MS);

		const delayHuge = computeRetryDelay(0, 100000, () => 0);
		expect(delayHuge).toBe(MAX_RETRY_DELAY_MS);
	});
});
