// Minimal stub of the `obsidian` module so pure modules that import it
// (e.g. template.ts) can be loaded under Vitest without the real Obsidian
// runtime. Only the members our source touches are provided.

import momentModule from "moment";

export class TFile {}

export class App {}

export const moment = momentModule;

/**
 * Mirrors Obsidian's own `normalizePath`: backslashes become forward slashes,
 * runs of slashes collapse, leading and trailing slashes are dropped, the result
 * is NFC-normalized, and an empty result becomes "/".
 *
 * The leading/trailing strip is the part worth having here. Code that appends its
 * own "/" to build a folder prefix behaves differently without it, so a stub that
 * only collapses runs would let a test pass while describing path handling the
 * plugin does not actually have.
 */
export function normalizePath(path: string): string {
	const normalized = path
		.replace(/[\\/]+/g, "/")
		.replace(/^\/+|\/+$/g, "")
		.normalize("NFC");
	return normalized === "" ? "/" : normalized;
}
