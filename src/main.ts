import { Notice, Plugin, TFile, normalizePath } from "obsidian";
import type { OAuthTokens, OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
	GranolaSyncSettings,
	DEFAULT_SETTINGS,
	GranolaSyncSettingTab,
	SYNC_FREQUENCY_MS,
} from "./settings";
import { GranolaAuthProvider, type AuthStorage } from "./auth";
import { GranolaMcpClient } from "./mcp-client";
import { syncFolderFirst } from "./note-scope";
import { RateLimiter } from "./rate-limiter";
import {
	parseMeetingsResponse,
	parseTranscriptResponse,
	parseAccountInfo,
	buildMeetingData,
	excludeSelf,
	type ParsedMeetingDetails,
} from "./response-parser";
import {
	loadTemplate,
	applyTemplate,
	getFolderBasePath,
	resolveNotePath,
	resolveTranscriptPath,
} from "./template";
import {
	createInitialSyncProgress,
	formatStatusBarText,
	sleep,
	type SyncProgressState,
} from "./sync-progress";
import DEFAULT_TRANSCRIPT_TEMPLATE from "./default-transcript-template.md";

const TRANSCRIPT_FETCH_SPACING_MS = 65_000;

export interface GranolaAccount {
	id: string;
	label?: string;
	/** Signed-in address, used to keep the account owner out of attendee lists. */
	email?: string;
	oauthTokens?: OAuthTokens;
	oauthClientInfo?: OAuthClientInformationMixed;
	/** Set when the stored tokens could no longer be refreshed and a login is required. */
	needsReauth?: boolean;
}

interface PluginData extends GranolaSyncSettings {
	accounts?: GranolaAccount[];
	// Legacy single-account fields, migrated into `accounts` on load.
	oauthTokens?: OAuthTokens;
	oauthClientInfo?: OAuthClientInformationMixed;
	autoSyncOnStartup?: boolean;
}

interface AccountRuntime {
	auth: GranolaAuthProvider;
	mcp: GranolaMcpClient;
}

export default class GranolaSyncPlugin extends Plugin {
	settings: GranolaSyncSettings = DEFAULT_SETTINGS;
	accounts: GranolaAccount[] = [];
	private pluginData: PluginData = { ...DEFAULT_SETTINGS };
	private isSyncing = false;
	private syncAbortController: AbortController | null = null;
	private statusBarItemEl: HTMLElement | null = null;
	private progressState: SyncProgressState = createInitialSyncProgress();
	private progressListeners = new Set<(state: SyncProgressState) => void>();
	private syncIntervalId: number | null = null;
	private ribbonIconEl: HTMLElement | null = null;
	private settingTab: GranolaSyncSettingTab | null = null;
	private runtimes = new Map<string, AccountRuntime>();
	private pendingAuthAccountId: string | null = null;
	/** Folders created or confirmed during the current sync run. */
	private ensuredFolders = new Set<string>();
	private rateLimiter = new RateLimiter();

	get isSyncActive(): boolean {
		return this.isSyncing;
	}

	get currentSyncProgress(): SyncProgressState {
		return this.progressState;
	}

	onProgress(listener: (state: SyncProgressState) => void): () => void {
		this.progressListeners.add(listener);
		listener(this.progressState);
		return () => {
			this.progressListeners.delete(listener);
		};
	}

	notifyProgress(state: SyncProgressState): void {
		this.progressState = state;
		this.updateStatusBar();
		for (const listener of this.progressListeners) {
			try {
				listener(state);
			} catch (e) {
				console.error("Granola: error in progress listener", e);
			}
		}
	}

	private updateStatusBar(): void {
		if (!this.statusBarItemEl) return;
		const text = formatStatusBarText(this.progressState);
		this.statusBarItemEl.setText(text);
		this.statusBarItemEl.style.display = text ? "inline-block" : "none";
	}

	cancelSync(): void {
		if (this.syncAbortController && !this.syncAbortController.signal.aborted) {
			this.notifyProgress({
				...this.progressState,
				phase: "stopping",
				message: "Stopping sync...",
			});
			this.syncAbortController.abort();
			new Notice("Stopping Granola sync...");
		}
	}

	private isAbortError(error: unknown): boolean {
		return (
			(error instanceof DOMException && error.name === "AbortError") ||
			(error instanceof Error &&
				(error.name === "AbortError" || error.message.toLowerCase().includes("abort")))
		);
	}

	override async onload(): Promise<void> {
		await this.loadSettings();

		// Create status bar element
		this.statusBarItemEl = this.addStatusBarItem();
		this.updateStatusBar();

		// Register OAuth callback handler
		this.registerObsidianProtocolHandler("granola-auth", (params) => {
			const code = params.code;
			if (code) {
				void this.handleAuthCallback(code, params.state);
			}
		});

		// Add ribbon icon if enabled
		this.updateRibbonIcon();

		// Add commands
		this.addCommand({
			id: "sync-meetings",
			name: "Sync meetings",
			callback: () => void this.syncMeetings(true),
		});

		this.addCommand({
			id: "open-settings",
			name: "Open settings",
			callback: () => {
				const appWithSetting = this.app as typeof this.app & {
					setting: { open: () => void; openTabById: (id: string) => void };
				};
				appWithSetting.setting.open();
				appWithSetting.setting.openTabById(this.manifest.id);
			},
		});

		// Add settings tab
		this.settingTab = new GranolaSyncSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		// Handle startup sync and intervals
		this.app.workspace.onLayoutReady(() => {
			if (this.settings.syncFrequency !== "manual") {
				void this.syncMeetings();
			}
			this.setupSyncInterval();
		});
	}

	/**
	 * Runs once, when the user first enables the plugin. Write the default
	 * templates now rather than leaving it to the first sync.
	 */
	override onUserEnable(): void {
		void loadTemplate(this.app, this.settings.templatePath).catch((error: unknown) => {
			console.error("Granola: failed to create the default template", error);
		});
		void loadTemplate(
			this.app,
			this.settings.transcriptTemplatePath,
			DEFAULT_TRANSCRIPT_TEMPLATE,
		).catch((error: unknown) => {
			console.error("Granola: failed to create default transcript template", error);
		});
	}

	override onunload(): void {
		this.clearSyncInterval();
		this.rateLimiter.reset();
		if (this.syncAbortController) {
			this.syncAbortController.abort();
			this.syncAbortController = null;
		}
		this.progressListeners.clear();
		for (const runtime of this.runtimes.values()) {
			void runtime.mcp.disconnect();
		}
		this.runtimes.clear();
	}

	setupSyncInterval(): void {
		this.clearSyncInterval();
		const intervalMs = SYNC_FREQUENCY_MS[this.settings.syncFrequency];
		if (intervalMs) {
			this.syncIntervalId = window.setInterval(() => {
				void this.syncMeetings();
			}, intervalMs);
			this.registerInterval(this.syncIntervalId);
		}
	}

	private clearSyncInterval(): void {
		if (this.syncIntervalId !== null) {
			window.clearInterval(this.syncIntervalId);
			this.syncIntervalId = null;
		}
	}

	updateRibbonIcon(): void {
		if (this.settings.showRibbonIcon && !this.ribbonIconEl) {
			this.ribbonIconEl = this.addRibbonIcon("calendar-sync", "Sync Granola meetings", () => {
				void this.syncMeetings(true);
			});
		} else if (!this.settings.showRibbonIcon && this.ribbonIconEl) {
			this.ribbonIconEl.remove();
			this.ribbonIconEl = null;
		}
	}

	/** True when at least one account is connected. */
	isAuthenticated(): boolean {
		return this.accounts.some((a) => a.oauthTokens !== undefined);
	}

	/** Build (or reuse) the auth provider + MCP client for an account. */
	private getRuntime(account: GranolaAccount): AccountRuntime {
		const existing = this.runtimes.get(account.id);
		if (existing) return existing;

		const storage: AuthStorage = {
			getTokens: () => this.findAccount(account.id)?.oauthTokens,
			saveTokens: async (tokens) => {
				const a = this.findAccount(account.id);
				if (a) {
					a.oauthTokens = tokens;
					await this.savePluginData();
				}
			},
			clearTokens: async () => {
				const a = this.findAccount(account.id);
				if (a) {
					delete a.oauthTokens;
					delete a.oauthClientInfo;
					await this.savePluginData();
				}
			},
			getClientInfo: () => this.findAccount(account.id)?.oauthClientInfo,
			saveClientInfo: async (info) => {
				const a = this.findAccount(account.id);
				if (a) {
					a.oauthClientInfo = info;
					await this.savePluginData();
				}
			},
		};
		const auth = new GranolaAuthProvider(storage, account.id, () => {
			const a = this.findAccount(account.id);
			if (a && !a.needsReauth) {
				a.needsReauth = true;
				void this.savePluginData();
				this.refreshSettingsTab();
			}
		});
		const mcp = new GranolaMcpClient(auth, this.rateLimiter);
		const runtime: AccountRuntime = { auth, mcp };
		this.runtimes.set(account.id, runtime);
		return runtime;
	}

	private findAccount(id: string): GranolaAccount | undefined {
		return this.accounts.find((a) => a.id === id);
	}

	/** Start the OAuth flow for a brand-new account. */
	async addAccount(): Promise<void> {
		const account: GranolaAccount = { id: generateAccountId() };
		this.accounts.push(account);
		this.pendingAuthAccountId = account.id;
		await this.savePluginData();

		const { mcp } = this.getRuntime(account);
		try {
			await mcp.connect();
			// Already authorized (unlikely for a fresh account) — finalize now.
			await this.finalizeAccount(account);
			new Notice("Connected to Granola!");
		} catch {
			// Auth redirect happened — user completes login in browser.
			new Notice("Opening Granola login in your browser...");
		}
	}

	async disconnectAccount(id: string): Promise<void> {
		const runtime = this.runtimes.get(id);
		if (runtime) {
			await runtime.mcp.disconnect();
			this.runtimes.delete(id);
		}
		this.accounts = this.accounts.filter((a) => a.id !== id);
		if (this.pendingAuthAccountId === id) this.pendingAuthAccountId = null;
		await this.savePluginData();
		new Notice("Disconnected from Granola");
	}

	/** Re-run the login flow for an existing account whose tokens went stale. */
	async reconnectAccount(id: string): Promise<void> {
		const account = this.findAccount(id);
		if (!account) return;
		this.pendingAuthAccountId = account.id;

		const { mcp } = this.getRuntime(account);
		try {
			await mcp.connect();
			// Tokens refreshed silently — no login window was needed.
			await this.finalizeAccount(account);
			new Notice("Reconnected to Granola!");
			this.refreshSettingsTab();
		} catch {
			new Notice("Opening Granola login in your browser...");
		}
	}

	private async handleAuthCallback(code: string, state?: string): Promise<void> {
		// Prefer the `state` param (survives multiple concurrent logins);
		// fall back to the pending id for older flows.
		const accountId = state || this.pendingAuthAccountId;
		const account = accountId ? this.findAccount(accountId) : undefined;
		if (!account) {
			console.error("Granola: auth callback with no matching account");
			return;
		}
		try {
			const { mcp } = this.getRuntime(account);
			await mcp.finishAuth(code);
			await this.finalizeAccount(account);
			new Notice("Successfully connected to Granola!");
			this.refreshSettingsTab();
		} catch (error) {
			console.error("Granola auth callback failed:", error);
			new Notice("Failed to connect to Granola. Please try again.");
			// Drop the half-connected account so it doesn't linger in settings.
			await this.disconnectAccount(account.id);
		} finally {
			if (this.pendingAuthAccountId === account.id) {
				this.pendingAuthAccountId = null;
			}
		}
	}

	/** After a successful auth, fetch the account's email/name as its label. */
	private async finalizeAccount(account: GranolaAccount): Promise<void> {
		const { mcp } = this.getRuntime(account);
		account.needsReauth = false;
		try {
			if (!mcp.isConnected) await mcp.connect();
			const { label, email } = parseAccountInfo(await mcp.getAccountInfo());
			if (label) account.label = label;
			if (email) account.email = email;
		} catch (error) {
			console.error("Granola: failed to fetch account info", error);
		}
		await this.savePluginData();
	}

	/** Re-read the setting definitions so account rows reflect the current state. */
	private refreshSettingsTab(): void {
		this.settingTab?.update();
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<PluginData> | null;
		this.pluginData = { ...DEFAULT_SETTINGS, ...data };
		this.settings = { ...DEFAULT_SETTINGS, ...data };

		// Migrate old autoSyncOnStartup setting
		if (data?.autoSyncOnStartup !== undefined && !data.syncFrequency) {
			this.settings.syncFrequency = data.autoSyncOnStartup ? "startup" : "manual";
		}

		// Load accounts, migrating a legacy single-account connection if present.
		this.accounts = this.pluginData.accounts ?? [];
		if (this.accounts.length === 0 && this.pluginData.oauthTokens) {
			this.accounts = [
				{
					id: generateAccountId(),
					oauthTokens: this.pluginData.oauthTokens,
					oauthClientInfo: this.pluginData.oauthClientInfo,
				},
			];
		}
		delete this.pluginData.oauthTokens;
		delete this.pluginData.oauthClientInfo;
		this.pluginData.accounts = this.accounts;
	}

	/**
	 * `data.json` was rewritten underneath us — with the vault on a file sync,
	 * that is usually another machine storing tokens it just refreshed. Adopt
	 * them: keeping the copy loaded at startup means the next local write puts
	 * stale tokens back, and once the refresh token has rotated that signs both
	 * machines out.
	 */
	override async onExternalSettingsChange(): Promise<void> {
		const previousAccounts = this.accounts;
		const previousFrequency = this.settings.syncFrequency;

		await this.loadSettings();

		// A login in flight is only in our copy — the machine that wrote this
		// file has never heard of it. Without this the OAuth callback comes back
		// to no account and the sign-in has to be started over.
		const pending = previousAccounts.find((a) => a.id === this.pendingAuthAccountId);
		if (pending && !this.findAccount(pending.id)) {
			this.accounts.push(pending);
			this.pluginData.accounts = this.accounts;
		}

		// Drop the clients for accounts disconnected on the other machine.
		for (const account of previousAccounts) {
			if (!this.findAccount(account.id)) {
				const runtime = this.runtimes.get(account.id);
				if (runtime) {
					void runtime.mcp.disconnect();
					this.runtimes.delete(account.id);
				}
			}
		}

		// Only on a real change: restarting the timer resets its countdown, and
		// the other machine's own syncs write this file on their own schedule.
		if (this.settings.syncFrequency !== previousFrequency) {
			this.setupSyncInterval();
		}
		this.updateRibbonIcon();
		this.refreshSettingsTab();
	}

	async saveSettings(): Promise<void> {
		Object.assign(this.pluginData, this.settings);
		await this.savePluginData();
	}

	private async savePluginData(): Promise<void> {
		this.pluginData.accounts = this.accounts;
		await this.saveData(this.pluginData);
	}

	async syncMeetings(manual = false): Promise<void> {
		if (this.isSyncing) return;
		this.isSyncing = true;
		this.syncAbortController = new AbortController();
		// Folders can be deleted between runs, so never trust the last run's memo.
		this.ensuredFolders.clear();

		try {
			await this.doSync(manual, this.syncAbortController.signal);
		} catch (error) {
			if (this.isAbortError(error)) {
				if (manual) new Notice("Granola sync stopped");
			} else {
				console.error("Granola: sync error", error);
				if (manual) {
					new Notice(
						`Granola sync error: ${error instanceof Error ? error.message : "Unknown error"}`,
					);
				}
			}
		} finally {
			this.isSyncing = false;
			this.syncAbortController = null;
			this.notifyProgress(createInitialSyncProgress());
		}
	}

	private async doSync(manual: boolean, signal: AbortSignal): Promise<void> {
		if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");

		const connectedAccounts = this.accounts.filter((a) => a.oauthTokens !== undefined);
		if (connectedAccounts.length === 0) {
			if (manual) {
				new Notice("Please connect your Granola account first in plugin settings");
			}
			return;
		}

		this.notifyProgress({
			phase: "listing",
			current: 0,
			total: 0,
			message: "Checking for meetings in Granola...",
		});

		const folderPathSetting = this.settings.folderPath || DEFAULT_SETTINGS.folderPath;
		const templatePath = this.settings.templatePath || DEFAULT_SETTINGS.templatePath;
		const filenamePattern = this.settings.filenamePattern || DEFAULT_SETTINGS.filenamePattern;

		const transcriptFolderSetting =
			this.settings.transcriptFolder || DEFAULT_SETTINGS.transcriptFolder;
		const transcriptFilenamePattern =
			this.settings.transcriptFilenamePattern || DEFAULT_SETTINGS.transcriptFilenamePattern;
		const transcriptTemplatePath =
			this.settings.transcriptTemplatePath || DEFAULT_SETTINGS.transcriptTemplatePath;

		// Load templates
		let template: string;
		let transcriptTemplate = "";
		try {
			template = await loadTemplate(this.app, templatePath);
			if (this.settings.syncTranscripts) {
				transcriptTemplate = await loadTemplate(
					this.app,
					transcriptTemplatePath,
					DEFAULT_TRANSCRIPT_TEMPLATE,
				);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			new Notice(`Error loading template: ${message}`);
			return;
		}

		if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");

		const folderPathPattern = normalizePath(folderPathSetting);
		const folderBasePath = getFolderBasePath(folderPathPattern);
		try {
			await this.ensureFolderExists(folderBasePath);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			new Notice(`Error creating folder: ${message}`);
			return;
		}

		// Build map of existing granola_id -> file (shared across all accounts).
		// Notes with type: transcript go to existingTranscripts; others go to existingDocs.
		const existingDocs = new Map<string, TFile>();
		const existingTranscripts = new Map<string, TFile>();
		const files = this.app.vault.getMarkdownFiles();
		for (const file of syncFolderFirst(files, folderBasePath)) {
			const fileCache = this.app.metadataCache.getFileCache(file);
			const granolaId = fileCache?.frontmatter?.granola_id as string | undefined;
			const type = fileCache?.frontmatter?.type as string | undefined;
			if (granolaId) {
				if (type === "transcript") {
					if (!existingTranscripts.has(granolaId)) {
						existingTranscripts.set(granolaId, file);
					}
				} else {
					if (!existingDocs.has(granolaId)) {
						existingDocs.set(granolaId, file);
					}
				}
			}
		}

		// Build map of email -> note title for attendee matching (shared)
		const emailToNoteTitle = new Map<string, string>();
		if (this.settings.matchAttendeesByEmail) {
			for (const file of files) {
				const fileCache = this.app.metadataCache.getFileCache(file);
				const emails: unknown = fileCache?.frontmatter?.emails;
				if (Array.isArray(emails)) {
					for (const email of emails) {
						if (typeof email === "string") {
							emailToNoteTitle.set(email.toLowerCase(), file.basename);
						}
					}
				} else if (typeof emails === "string") {
					emailToNoteTitle.set(emails.toLowerCase(), file.basename);
				}
			}
		}

		const ctx: SyncContext = {
			template,
			transcriptTemplate,
			folderPathPattern,
			filenamePattern,
			transcriptFolderPattern: transcriptFolderSetting,
			transcriptFilenamePattern,
			existingDocs,
			existingTranscripts,
			emailToNoteTitle,
			signal,
		};

		let created = 0;
		let updated = 0;
		let skipped = 0;
		let transcriptsCreated = 0;
		let failedAccounts = 0;

		for (const account of connectedAccounts) {
			if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
			try {
				const result = await this.syncAccount(account, ctx);
				created += result.created;
				updated += result.updated;
				skipped += result.skipped;
				transcriptsCreated += result.transcriptsCreated;
			} catch (error) {
				if (this.isAbortError(error)) throw error;
				failedAccounts++;
				console.error(`Granola: sync failed for account ${account.label ?? account.id}`, error);
			}
		}

		if (manual) {
			const accountSuffix =
				connectedAccounts.length > 1 ? ` across ${connectedAccounts.length} accounts` : "";
			let message: string;
			if (this.settings.skipExistingNotes) {
				message = `Synced ${created} new meeting${created !== 1 ? "s" : ""} (${skipped} skipped)${accountSuffix}`;
			} else {
				message = `Synced ${created} new, ${updated} updated meeting${created + updated !== 1 ? "s" : ""}${accountSuffix}`;
			}
			if (transcriptsCreated > 0) {
				message += `, ${transcriptsCreated} transcript${transcriptsCreated !== 1 ? "s" : ""}`;
			}
			if (failedAccounts > 0) {
				message += `. ${failedAccounts} account${failedAccounts !== 1 ? "s" : ""} failed — check console.`;
			}
			new Notice(message);
		}
	}

	/**
	 * Create `folderPath` and any missing parents.
	 *
	 * Walks the path a segment at a time rather than handing the whole thing to
	 * `vault.createFolder`, whose recursive behaviour is not part of its documented
	 * contract. Every confirmed segment is remembered for the rest of the run, so a
	 * sync filing 100 meetings into one dated folder checks the vault index once
	 * instead of once per note.
	 */
	private async ensureFolderExists(folderPath: string): Promise<void> {
		const normalizedPath = normalizePath(folderPath);
		if (this.ensuredFolders.has(normalizedPath)) return;

		let currentPath = "";
		for (const part of normalizedPath.split("/").filter(Boolean)) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(currentPath)) {
				await this.app.vault.createFolder(currentPath);
			}
			this.ensuredFolders.add(currentPath);
		}
		this.ensuredFolders.add(normalizedPath);
	}

	/** Sync a single account into the shared folder, mutating ctx.existingDocs. */
	private async syncAccount(account: GranolaAccount, ctx: SyncContext): Promise<SyncResult> {
		if (ctx.signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
		const { mcp } = this.getRuntime(account);

		if (!mcp.isConnected) {
			await mcp.connect();
		}

		// Connection succeeded, so the tokens are valid again.
		if (account.needsReauth) {
			account.needsReauth = false;
			await this.savePluginData();
			this.refreshSettingsTab();
		}

		// Backfill the account name if we never captured it (e.g. accounts
		// connected before labels existed, or where the initial fetch failed).
		if (!account.label || !account.email) {
			try {
				const { label, email } = parseAccountInfo(await mcp.getAccountInfo(ctx.signal));
				if (label || email) {
					if (label) account.label = label;
					if (email) account.email = email;
					await this.savePluginData();
					this.refreshSettingsTab();
				}
			} catch (error) {
				if (this.isAbortError(error)) throw error;
				console.error("Granola: failed to backfill account name", error);
			}
		}

		// List meetings
		this.notifyProgress({
			phase: "listing",
			current: 0,
			total: 0,
			message: `Checking meetings for ${account.label ?? account.id}...`,
		});

		let listResponse: string;
		try {
			listResponse = await mcp.listMeetings(
				this.settings.syncTimeRange,
				this.settings.onlyMyMeetings,
				ctx.signal,
			);
		} catch (error) {
			if (this.isAbortError(error)) throw error;
			// Disconnect so we retry connection next time
			await mcp.disconnect();
			throw error;
		}

		const listedMeetings = parseMeetingsResponse(listResponse);
		if (listedMeetings.length === 0) {
			return { created: 0, updated: 0, skipped: 0, transcriptsCreated: 0 };
		}

		// Determine which meetings need note creation/update
		const meetingsToSyncNotes = listedMeetings.filter((m) => {
			if (this.settings.skipExistingNotes && ctx.existingDocs.has(m.id)) {
				return false;
			}
			return true;
		});

		// Determine which meetings need transcripts
		const meetingsToSyncTranscripts = this.settings.syncTranscripts
			? listedMeetings.filter((m) => !ctx.existingTranscripts.has(m.id))
			: [];

		const skipped = listedMeetings.length - meetingsToSyncNotes.length;

		// We need details for any meeting that either needs a note update OR needs a transcript
		const neededIdsSet = new Set<string>();
		for (const m of meetingsToSyncNotes) neededIdsSet.add(m.id);
		for (const m of meetingsToSyncTranscripts) neededIdsSet.add(m.id);

		const idsToFetch = Array.from(neededIdsSet);
		const allDetails: ParsedMeetingDetails[] = [];
		const detailsMap = new Map<string, ParsedMeetingDetails>();

		for (let i = 0; i < idsToFetch.length; i += 10) {
			if (ctx.signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
			const batch = idsToFetch.slice(i, i + 10);
			try {
				const detailsResponse = await mcp.getMeetings(batch, ctx.signal);
				const parsed = parseMeetingsResponse(detailsResponse);
				allDetails.push(...parsed);
				for (const item of parsed) {
					detailsMap.set(item.id, item);
				}
			} catch (error) {
				if (this.isAbortError(error)) throw error;
				console.error("Granola: getMeetings batch failed", error);
			}
		}

		let created = 0;
		let updated = 0;

		// ----------------------------------------------------
		// PHASE 1: Sync Meeting Notes
		// ----------------------------------------------------
		const noteTargetDetails = allDetails.filter((d) =>
			meetingsToSyncNotes.some((m) => m.id === d.id),
		);

		for (let i = 0; i < noteTargetDetails.length; i++) {
			if (ctx.signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
			const details = noteTargetDetails[i];
			try {
				// Skip meetings still in progress (no summary generated yet)
				if (!details.summary.trim() || details.summary.trim() === "No summary") {
					continue;
				}

				this.notifyProgress({
					phase: "meetings",
					current: i + 1,
					total: noteTargetDetails.length,
					message: `Saving meeting ${i + 1} of ${noteTargetDetails.length}...`,
				});

				const meetingData = buildMeetingData(details, "");
				if (this.settings.excludeSelfFromAttendees && account.email) {
					meetingData.participants = excludeSelf(meetingData.participants, account.email);
				}

				const existingFile = ctx.existingDocs.get(details.id);
				const meetingPathInfo = resolveNotePath(
					ctx.folderPathPattern,
					ctx.filenamePattern,
					meetingData,
				);
				const transcriptPathInfo = resolveTranscriptPath(
					ctx.transcriptFolderPattern,
					ctx.transcriptFilenamePattern,
					meetingData,
					meetingPathInfo.folder,
					meetingPathInfo.filename,
				);

				const content = applyTemplate(ctx.template, meetingData, ctx.emailToNoteTitle, {
					granola_meeting_transcript: transcriptPathInfo.filename,
				});

				if (existingFile) {
					await this.app.vault.modify(existingFile, content);
					updated++;
				} else {
					await this.ensureFolderExists(meetingPathInfo.folder);
					const newFile = await this.app.vault.create(meetingPathInfo.path, content);
					// Track so a meeting shared across accounts isn't created twice this run.
					ctx.existingDocs.set(details.id, newFile);
					created++;
				}
			} catch (error) {
				if (this.isAbortError(error)) throw error;
				console.error(`Error syncing meeting ${details.id}:`, error);
			}
		}

		// ----------------------------------------------------
		// PHASE 2: Sync Transcripts (Separated & Paced)
		// ----------------------------------------------------
		let transcriptsCreated = 0;
		if (this.settings.syncTranscripts && meetingsToSyncTranscripts.length > 0) {
			for (let i = 0; i < meetingsToSyncTranscripts.length; i++) {
				if (ctx.signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
				const m = meetingsToSyncTranscripts[i];
				const details = detailsMap.get(m.id);
				// If no details or no summary, meeting may still be in progress
				if (!details || !details.summary.trim() || details.summary.trim() === "No summary") {
					continue;
				}

				// Enforce pacing between transcript fetches (~65 seconds)
				if (i > 0) {
					await sleep(TRANSCRIPT_FETCH_SPACING_MS, ctx.signal, (remainingSeconds) => {
						this.notifyProgress({
							phase: "transcripts",
							current: i,
							total: meetingsToSyncTranscripts.length,
							countdownSeconds: remainingSeconds,
							message: "",
						});
					});
				}

				this.notifyProgress({
					phase: "transcripts",
					current: i + 1,
					total: meetingsToSyncTranscripts.length,
					message: `Downloading transcript ${i + 1} of ${meetingsToSyncTranscripts.length}...`,
				});

				let rawTranscript = "";
				try {
					rawTranscript = await mcp.getTranscript(m.id, ctx.signal);
				} catch (error) {
					if (this.isAbortError(error)) throw error;
					console.error(`Granola: transcript fetch failed for ${m.id}`, error);
					continue;
				}

				const transcript = parseTranscriptResponse(rawTranscript);
				if (!transcript) {
					continue;
				}

				try {
					const meetingData = buildMeetingData(details, transcript);
					if (this.settings.excludeSelfFromAttendees && account.email) {
						meetingData.participants = excludeSelf(meetingData.participants, account.email);
					}

					const meetingPathInfo = resolveNotePath(
						ctx.folderPathPattern,
						ctx.filenamePattern,
						meetingData,
					);
					const transcriptPathInfo = resolveTranscriptPath(
						ctx.transcriptFolderPattern,
						ctx.transcriptFilenamePattern,
						meetingData,
						meetingPathInfo.folder,
						meetingPathInfo.filename,
					);

					const transcriptContent = applyTemplate(
						ctx.transcriptTemplate,
						meetingData,
						ctx.emailToNoteTitle,
						{
							granola_meeting_note: meetingPathInfo.filename,
						},
					);

					await this.ensureFolderExists(transcriptPathInfo.folder);
					const existingTranscriptFile = ctx.existingTranscripts.get(m.id);
					if (existingTranscriptFile) {
						await this.app.vault.modify(existingTranscriptFile, transcriptContent);
					} else {
						const newTranscriptFile = await this.app.vault.create(
							transcriptPathInfo.path,
							transcriptContent,
						);
						ctx.existingTranscripts.set(m.id, newTranscriptFile);
					}
					transcriptsCreated++;
				} catch (error) {
					if (this.isAbortError(error)) throw error;
					console.error(`Error saving transcript note ${m.id}:`, error);
				}
			}
		}

		return { created, updated, skipped, transcriptsCreated };
	}
}

interface SyncContext {
	template: string;
	transcriptTemplate: string;
	folderPathPattern: string;
	filenamePattern: string;
	transcriptFolderPattern: string;
	transcriptFilenamePattern: string;
	existingDocs: Map<string, TFile>;
	existingTranscripts: Map<string, TFile>;
	emailToNoteTitle: Map<string, string>;
	signal: AbortSignal;
}

interface SyncResult {
	created: number;
	updated: number;
	skipped: number;
	transcriptsCreated: number;
}

function generateAccountId(): string {
	const cryptoObj = window.crypto as Crypto | undefined;
	if (cryptoObj?.randomUUID) {
		return cryptoObj.randomUUID();
	}
	return `acct-${Math.random().toString(36).slice(2)}`;
}
