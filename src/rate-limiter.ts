/**
 * Proactive request scheduler / rate limiter.
 *
 * Granola's MCP API enforces an average limit of ~100 requests per minute.
 * To avoid hitting rate limits during batch operations (fetching meeting
 * details and transcripts), this scheduler ensures a minimum delay between
 * consecutive requests.
 */

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		window.setTimeout(resolve, ms);
	});
}

export class RateLimiter {
	private readonly minIntervalMs: number;
	private lastExecutionTime = 0;
	private queue: Promise<void> = Promise.resolve();

	/**
	 * @param minIntervalMs Minimum time in milliseconds between requests.
	 * Default is 650ms, which caps throughput at ~92 requests/minute.
	 */
	constructor(minIntervalMs = 650) {
		this.minIntervalMs = minIntervalMs;
	}

	/**
	 * Queue an async operation to execute after the minimum interval has passed.
	 */
	execute<T>(fn: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			this.queue = this.queue.then(async () => {
				const now = Date.now();
				const timeSinceLast = now - this.lastExecutionTime;
				if (this.lastExecutionTime > 0 && timeSinceLast < this.minIntervalMs) {
					const delay = this.minIntervalMs - timeSinceLast;
					await sleep(delay);
				}
				try {
					const res = await fn();
					resolve(res);
				} catch (err) {
					reject(err instanceof Error ? err : new Error(String(err)));
				} finally {
					this.lastExecutionTime = Date.now();
				}
			}).catch(() => {
				// Ensure queue chain continues even on error
			});
		});
	}

	/**
	 * Temporarily pause the queue for a backoff duration (e.g. when 429 is encountered).
	 */
	backoff(durationMs: number): Promise<void> {
		this.queue = this.queue.then(async () => {
			await sleep(durationMs);
			this.lastExecutionTime = Date.now();
		});
		return this.queue;
	}

	/**
	 * Reset the scheduler state.
	 */
	reset(): void {
		this.lastExecutionTime = 0;
		this.queue = Promise.resolve();
	}
}
