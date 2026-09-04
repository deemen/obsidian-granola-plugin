import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RateLimiter } from "./rate-limiter";

describe("RateLimiter", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("executes the first request immediately", async () => {
		const limiter = new RateLimiter(500);

		const promise = limiter.execute(async () => "done");
		await vi.advanceTimersByTimeAsync(0);

		expect(await promise).toBe("done");
	});

	it("paces consecutive requests according to minIntervalMs", async () => {
		const limiter = new RateLimiter(200);
		const results: number[] = [];

		const p1 = limiter.execute(async () => {
			results.push(Date.now());
		});
		const p2 = limiter.execute(async () => {
			results.push(Date.now());
		});

		await vi.advanceTimersByTimeAsync(0);
		await p1;
		expect(results.length).toBe(1);

		// Advance timer by 100ms (not yet 200ms)
		await vi.advanceTimersByTimeAsync(100);
		expect(results.length).toBe(1);

		// Advance timer past 200ms
		await vi.advanceTimersByTimeAsync(150);
		await p2;
		expect(results.length).toBe(2);
	});

	it("applies backoff delay to subsequent requests", async () => {
		const limiter = new RateLimiter(100);
		const timestamps: number[] = [];

		const p1 = limiter.execute(async () => {
			timestamps.push(Date.now());
		});
		await vi.advanceTimersByTimeAsync(0);
		await p1;
		expect(timestamps.length).toBe(1);

		// Trigger backoff of 500ms
		limiter.backoff(500);

		const nextPromise = limiter.execute(async () => {
			timestamps.push(Date.now());
		});

		// Advance by 300ms — should still be waiting for backoff
		await vi.advanceTimersByTimeAsync(300);
		expect(timestamps.length).toBe(1);

		// Advance remaining 300ms
		await vi.advanceTimersByTimeAsync(300);
		await nextPromise;
		expect(timestamps.length).toBe(2);
	});

	it("does not deadlock if backoff is called inside an execute task", async () => {
		const limiter = new RateLimiter(50);
		let completed = false;

		const p = limiter.execute(async () => {
			limiter.backoff(100);
			completed = true;
			return "ok";
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(completed).toBe(true);
		expect(await p).toBe("ok");
	});

	it("continues processing subsequent tasks even if one throws", async () => {
		const limiter = new RateLimiter(50);

		const p1 = limiter.execute(async () => {
			throw new Error("task failed");
		});

		const p2 = limiter.execute(async () => {
			return "second ok";
		});

		const p1Assertion = expect(p1).rejects.toThrow("task failed");
		await vi.advanceTimersByTimeAsync(0);
		await p1Assertion;

		await vi.advanceTimersByTimeAsync(60);
		expect(await p2).toBe("second ok");
	});
});
