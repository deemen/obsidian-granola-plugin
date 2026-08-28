/**
 * Order the vault's notes so the sync folder comes first.
 *
 * Existing notes are matched by `granola_id`, which only this plugin writes, so
 * the search covers the whole vault — a note you moved into a project folder is
 * then updated in place instead of being re-created in the sync folder. The
 * caller keeps the first file it sees for a given id, so leading with the sync
 * folder is what decides the winner when a meeting exists in two places.
 *
 * Generic over `{ path }` rather than taking `TFile` so it can be tested without
 * an Obsidian runtime.
 */
export function syncFolderFirst<T extends { path: string }>(files: T[], folderPath: string): T[] {
	const folderPrefix = folderPath + "/";
	return [
		...files.filter((f) => f.path.startsWith(folderPrefix)),
		...files.filter((f) => !f.path.startsWith(folderPrefix)),
	];
}
