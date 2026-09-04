import { App, ButtonComponent, PluginSettingTab } from "obsidian";
import type { SettingDefinitionItem, SettingGroupItem } from "obsidian";
import type GranolaSyncPlugin from "./main";
import type { GranolaAccount } from "./main";
import type { SyncTimeRange } from "./mcp-client";
import { formatProgressMessage, type SyncProgressState } from "./sync-progress";

export type SyncFrequency = "manual" | "startup" | "1m" | "15m" | "30m" | "60m" | "12h";

export const SYNC_FREQUENCY_OPTIONS: Record<SyncFrequency, string> = {
	manual: "Manual only (command palette)",
	startup: "Sync on startup only",
	"1m": "Every 1 minute",
	"15m": "Every 15 minutes",
	"30m": "Every 30 minutes",
	"60m": "Every 60 minutes",
	"12h": "Every 12 hours",
};

export const SYNC_FREQUENCY_MS: Record<SyncFrequency, number | null> = {
	manual: null,
	startup: null,
	"1m": 60 * 1000,
	"15m": 15 * 60 * 1000,
	"30m": 30 * 60 * 1000,
	"60m": 60 * 60 * 1000,
	"12h": 12 * 60 * 60 * 1000,
};

const SYNC_TIME_RANGE_OPTIONS: Record<SyncTimeRange, string> = {
	this_week: "This week",
	last_week: "Last week",
	last_30_days: "Last 30 days",
	last_90_days: "Last 90 days",
	last_180_days: "Last 180 days",
	last_1_year: "Last 1 year",
	all_time: "All time",
};

export interface GranolaSyncSettings {
	folderPath: string;
	filenamePattern: string;
	templatePath: string;
	syncFrequency: SyncFrequency;
	showRibbonIcon: boolean;
	skipExistingNotes: boolean;
	matchAttendeesByEmail: boolean;
	excludeSelfFromAttendees: boolean;
	syncTimeRange: SyncTimeRange;
	syncTranscripts: boolean;
	onlyMyMeetings: boolean;
	transcriptFolder: string;
	transcriptFilenamePattern: string;
	transcriptTemplatePath: string;
}

export const DEFAULT_SETTINGS: GranolaSyncSettings = {
	folderPath: "Meetings",
	filenamePattern: "{date} {title}",
	templatePath: "Templates/Granola.md",
	syncFrequency: "15m",
	showRibbonIcon: true,
	skipExistingNotes: true,
	matchAttendeesByEmail: true,
	excludeSelfFromAttendees: true,
	syncTimeRange: "last_30_days",
	syncTranscripts: false,
	onlyMyMeetings: true,
	transcriptFolder: "{meeting_folder}/Transcripts",
	transcriptFilenamePattern: "{filename} (Transcript)",
	transcriptTemplatePath: "Templates/Granola Transcript.md",
};

type SettingKey = keyof GranolaSyncSettings;

export class GranolaSyncSettingTab extends PluginSettingTab {
	plugin: GranolaSyncPlugin;
	private unbindProgress: (() => void) | null = null;

	constructor(app: App, plugin: GranolaSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	override hide(): void {
		super.hide();
		if (this.unbindProgress) {
			this.unbindProgress();
			this.unbindProgress = null;
		}
	}

	override getSettingDefinitions(): SettingDefinitionItem<SettingKey>[] {
		return [this.accountsList(), this.syncGroup(), this.notesGroup()];
	}

	/**
	 * Persist through the plugin rather than the inherited default, which writes
	 * `plugin.settings` straight to data.json — that file also carries the stored
	 * OAuth accounts, so a direct write would drop them and force a re-login.
	 * Settings whose value drives live state apply it here too.
	 */
	override async setControlValue(key: string, value: unknown): Promise<void> {
		Object.assign(this.plugin.settings, { [key]: value });
		await this.plugin.saveSettings();

		if (key === "syncFrequency") this.plugin.setupSyncInterval();
		if (key === "showRibbonIcon") this.plugin.updateRibbonIcon();
	}

	private accountsList(): SettingDefinitionItem<SettingKey> {
		const connected = this.plugin.accounts.filter((a) => a.oauthTokens !== undefined);

		return {
			type: "list",
			heading: "Granola accounts",
			addItem: {
				name: "Add Granola account",
				action: () => void this.plugin.addAccount(),
			},
			items:
				connected.length === 0
					? [this.connectPrompt()]
					: connected.map((account) => this.accountRow(account)),
		};
	}

	private connectPrompt(): SettingGroupItem<SettingKey> {
		return {
			name: "Not connected",
			desc: "Connect a Granola account to sync meetings via the official API.",
			aliases: ["sign in", "log in", "oauth"],
			render: (setting) => {
				setting.addButton((button) =>
					button
						.setButtonText("Connect to Granola")
						.setCta()
						.onClick(() => void this.plugin.addAccount())
				);
			},
		};
	}

	private accountRow(account: GranolaAccount): SettingGroupItem<SettingKey> {
		return {
			name: account.label || "Connected account",
			desc: account.needsReauth
				? "Reconnection required — your login expired. Sign in again to resume syncing."
				: account.label
					? "Connected and ready to sync."
					: "Connected. (Account name unavailable.)",
			// The row's name is the account label, so search needs the words a
			// user would actually type to find it.
			aliases: ["granola account", "disconnect", "reconnect", "sign out"],
			render: (setting) => {
				if (account.needsReauth) {
					setting.addButton((button) =>
						button
							.setButtonText("Reconnect")
							.setCta()
							.onClick(() => void this.plugin.reconnectAccount(account.id))
					);
				}

				setting.addButton((button) =>
					button
						.setButtonText("Disconnect")
						.setDestructive()
						.onClick(async () => {
							await this.plugin.disconnectAccount(account.id);
							this.update();
						})
				);
			},
		};
	}

	private syncGroup(): SettingDefinitionItem<SettingKey> {
		return {
			type: "group",
			heading: "Sync",
			items: [
				{
					name: "Sync now",
					desc: "Manually sync meetings from Granola",
					render: (setting) => {
						const progressContainer = setting.controlEl.createDiv({
							cls: "granola-sync-progress-container",
						});

						const buttonRow = progressContainer.createDiv();
						const statusRow = progressContainer.createDiv({
							cls: "granola-sync-status-text",
						});
						statusRow.hide();

						const progressBar = progressContainer.createEl("progress", {
							cls: "granola-sync-progress-bar",
						});
						progressBar.hide();

						let actionButton: ButtonComponent | null = null;

						const updateUI = (state: SyncProgressState) => {
							if (!actionButton) return;
							const isSyncing = this.plugin.isSyncActive || state.phase !== "idle";

							if (isSyncing) {
								actionButton.setButtonText(state.phase === "stopping" ? "Stopping..." : "Stop sync");
								actionButton.buttonEl.classList.remove("mod-cta");
								actionButton.setDestructive();
								actionButton.setDisabled(state.phase === "stopping");

								statusRow.setText(formatProgressMessage(state));
								statusRow.show();

								if (state.total > 0 && (state.phase === "meetings" || state.phase === "transcripts")) {
									progressBar.max = state.total;
									progressBar.value = state.current;
									progressBar.show();
								} else {
									progressBar.hide();
								}
							} else {
								actionButton.setButtonText("Sync now");
								actionButton.buttonEl.classList.remove("mod-warning", "mod-destructive");
								actionButton.setCta();
								actionButton.setDisabled(false);

								statusRow.setText("");
								statusRow.hide();
								progressBar.hide();
							}
						};

						setting.addButton((button) => {
							actionButton = button;
							buttonRow.appendChild(button.buttonEl);
							button.onClick(() => {
								if (this.plugin.isSyncActive) {
									this.plugin.cancelSync();
								} else {
									void this.plugin.syncMeetings(true);
								}
							});
							updateUI(this.plugin.currentSyncProgress);
						});

						if (this.unbindProgress) {
							this.unbindProgress();
						}
						this.unbindProgress = this.plugin.onProgress((state) => {
							updateUI(state);
						});
					},
				},
				{
					name: "Time range",
					desc: "How far back to look for meetings when syncing. Note: Granola Free plans only allow querying notes from the last 30 days.",
					control: {
						type: "dropdown",
						key: "syncTimeRange",
						options: SYNC_TIME_RANGE_OPTIONS,
						defaultValue: DEFAULT_SETTINGS.syncTimeRange,
					},
				},
				{
					name: "Sync frequency",
					desc: "How often to automatically sync meetings from Granola",
					control: {
						type: "dropdown",
						key: "syncFrequency",
						options: SYNC_FREQUENCY_OPTIONS,
						defaultValue: DEFAULT_SETTINGS.syncFrequency,
					},
				},
				{
					name: "Only my meetings",
					desc: "Sync only meetings you recorded or were listed as a participant in, including notes shared with you. Disable to also sync every workspace-visible meeting.",
					control: {
						type: "toggle",
						key: "onlyMyMeetings",
						defaultValue: DEFAULT_SETTINGS.onlyMyMeetings,
					},
				},
				{
					name: "Sync transcripts",
					desc: "Include full meeting transcripts saved as separate linked documents. Each transcript requires a paced API call (~65s spacing).",
					control: {
						type: "toggle",
						key: "syncTranscripts",
						defaultValue: DEFAULT_SETTINGS.syncTranscripts,
					},
				},
				{
					name: "Transcript folder",
					desc: "Where to save transcript notes. Supports {meeting_folder}, {date}, {granolaFolder}. Default saves in a Transcripts/ subfolder alongside the meeting note.",
					control: {
						type: "text",
						key: "transcriptFolder",
						placeholder: DEFAULT_SETTINGS.transcriptFolder,
						defaultValue: DEFAULT_SETTINGS.transcriptFolder,
					},
				},
				{
					name: "Transcript filename pattern",
					desc: "Pattern for transcript note filenames. Supports {filename}, {meeting_filename}, {title}, {date}, {id}.",
					control: {
						type: "text",
						key: "transcriptFilenamePattern",
						placeholder: DEFAULT_SETTINGS.transcriptFilenamePattern,
						defaultValue: DEFAULT_SETTINGS.transcriptFilenamePattern,
						validate: (value) =>
							value.trim() ? undefined : "Enter a pattern — transcripts need a filename.",
					},
				},
				{
					name: "Transcript template path",
					desc: "Path to transcript template file in your vault.",
					control: {
						type: "file",
						key: "transcriptTemplatePath",
						placeholder: DEFAULT_SETTINGS.transcriptTemplatePath,
						defaultValue: DEFAULT_SETTINGS.transcriptTemplatePath,
						filter: (file) => file.extension === "md",
					},
				},
			],
		};
	}

	private notesGroup(): SettingDefinitionItem<SettingKey> {
		return {
			type: "group",
			heading: "Notes",
			items: [
				{
					name: "Folder path",
					desc: "Where to save meeting notes. Supports {granolaFolder}, {date}, {date:YYYY/MM}, {title}, {id}.",
					// Plain text rather than a folder suggester: the value is a pattern,
					// and date tokens name folders that don't exist yet.
					control: {
						type: "text",
						key: "folderPath",
						placeholder: "Meetings",
						defaultValue: DEFAULT_SETTINGS.folderPath,
					},
				},
				{
					name: "Filename pattern",
					desc: "Pattern for note filenames. Available: {date}, {meeting_date}, {date:YYYY-MM-DD}, {title}, {meeting_name}, {id}, {granolaFolder}",
					control: {
						type: "text",
						key: "filenamePattern",
						placeholder: "{date} {title}",
						defaultValue: DEFAULT_SETTINGS.filenamePattern,
						validate: (value) =>
							value.trim() ? undefined : "Enter a pattern — notes need a filename.",
					},
				},
				{
					name: "Template path",
					desc: "Path to template file in your vault. A default one is created when the plugin is first enabled.",
					// A picker, so it can only choose files that already exist — which
					// is why the plugin writes the default template on enable rather
					// than waiting for the first sync. To start a new template from
					// the default, duplicate that file in the vault and pick the copy.
					control: {
						type: "file",
						key: "templatePath",
						placeholder: DEFAULT_SETTINGS.templatePath,
						defaultValue: DEFAULT_SETTINGS.templatePath,
						filter: (file) => file.extension === "md",
					},
				},
				{
					name: "Show ribbon icon",
					desc: "Show a sync button in the left ribbon",
					control: {
						type: "toggle",
						key: "showRibbonIcon",
						defaultValue: DEFAULT_SETTINGS.showRibbonIcon,
					},
				},
				{
					name: "Skip existing notes",
					desc: "When enabled, existing notes won't be overwritten. Disable to update notes when Granola data changes. Existing notes are matched by `granola_id` anywhere in your vault, not just the sync folder.",
					control: {
						type: "toggle",
						key: "skipExistingNotes",
						defaultValue: DEFAULT_SETTINGS.skipExistingNotes,
					},
				},
				{
					name: "Exclude yourself from attendees",
					desc: "Leave your own Granola account out of the attendee list, since you are listed on every meeting you take part in.",
					control: {
						type: "toggle",
						key: "excludeSelfFromAttendees",
						defaultValue: DEFAULT_SETTINGS.excludeSelfFromAttendees,
					},
				},
				{
					name: "Match attendees by email",
					desc: "Link attendees to existing notes that have a matching email in their 'emails' frontmatter property.",
					control: {
						type: "toggle",
						key: "matchAttendeesByEmail",
						defaultValue: DEFAULT_SETTINGS.matchAttendeesByEmail,
					},
				},
			],
		};
	}
}
