import { moment, normalizePath, Notice, Plugin, TFile } from 'obsidian';
import { HumanError } from './errors';
import { detectLocale, setLocale, t } from './i18n';
import { DEFAULT_SETTINGS, migrate, type Settings } from './settings';
import { SettingsTab } from './settings-tab';
import { SyncEngine } from './sync/engine';
import { BotClient } from './telegram/bot-client';
import { OpenAITranscriber } from './transcription';
import { VaultAttachmentStore } from './vault/attachments';
import { readCoreDailyNoteOptions, renderDailyTemplate } from './vault/core-daily-notes';
import { VaultNoteWriter } from './vault/writer';

/**
 * Obsidian bundles Moment. Using it avoids a dependency and gives users the
 * token syntax they already know from the core Daily Notes plugin.
 *
 * The cast is unavoidable: `obsidian.d.ts` exports `moment` as `typeof import('moment')`,
 * and we do not depend on `@types/moment`. Only `format` is used.
 */
type MomentFn = (date: Date) => { format(template: string): string };

export const formatDate = (template: string, date: Date): string =>
  (moment as unknown as MomentFn)(date).format(template);

export default class TelegramInboxPlugin extends Plugin {
  settings: Settings = { ...DEFAULT_SETTINGS };
  engine!: SyncEngine;
  client!: BotClient;

  private timer: number | null = null;

  async onload(): Promise<void> {
    setLocale(detectLocale());
    this.settings = migrate(await this.loadData());

    this.client = new BotClient({
      getToken: () => this.settings.botToken,
      getBoundChatId: () => this.settings.boundChatId,
      onBind: (chatId) => {
        this.settings.boundChatId = chatId;
        void this.saveSettings();
        new Notice(t('notice.bound'));
      },
      onLongWait: (seconds) => new Notice(t('error.rateLimited', { seconds })),
    });

    this.engine = new SyncEngine({
      source: this.client,
      writer: new VaultNoteWriter(this.app.vault),
      settings: () => this.effectiveSettings(),
      persist: async (patch) => {
        Object.assign(this.settings, patch);
        await this.saveSettings();
      },
      format: formatDate,
      onNotice: (e: HumanError) => new Notice(e.human),
      attachments: new VaultAttachmentStore({
        app: this.app,
        resolve: (fileId) => this.client.resolveFile(fileId),
        fetch: (filePath) => this.client.fetchFile(filePath),
        format: formatDate,
      }),
      transcriber: new OpenAITranscriber(),
      seed: (date) => this.dailyNoteSeed(date),
    });

    this.addSettingTab(new SettingsTab(this.app, this));

    this.addCommand({
      // TZ §7 / catalogue rule: the plugin id is prepended by Obsidian. Do not repeat it.
      id: 'sync-now',
      name: t('command.syncNow'),
      callback: () => void this.syncNow('manual'),
    });

    // Never poll during startup: the vault is not indexed and `getAbstractFileByPath`
    // lies about what exists.
    this.app.workspace.onLayoutReady(() => {
      void this.syncNow('startup');
      this.restartTimer();
    });
  }

  onunload(): void {
    this.stopTimer();
    void this.client.disconnect();
  }

  async syncNow(trigger: 'interval' | 'manual' | 'startup'): Promise<void> {
    const result = await this.engine.run(trigger);
    if (!result) return;

    if (trigger === 'manual' || result.written > 0) {
      if (result.written > 0) new Notice(t('notice.synced', { n: result.written }));
    }
    if (result.skipped.nonText > 0) {
      new Notice(t('notice.skipped.nonText', { n: result.skipped.nonText }));
    }
    if (result.skipped.foreignChat > 0) {
      new Notice(t('notice.skipped.foreignChat', { n: result.skipped.foreignChat }));
    }
  }

  /**
   * `registerInterval` ties the timer to the plugin lifecycle, so a disable →
   * enable cycle cannot leave an orphan polling in the background. Changing the
   * interval in settings tears the old one down first.
   */
  restartTimer(): void {
    this.stopTimer();
    const ms = this.settings.syncIntervalSeconds * 1000;
    this.timer = window.setInterval(() => void this.syncNow('interval'), ms);
    this.registerInterval(this.timer);
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * What the engine sees. With the toggle on and the core Daily Notes plugin
   * alive, its folder and name format replace ours — everything else is still
   * this plugin's own settings. Falls back silently when the core plugin is
   * off; the settings tab is where that state is explained.
   */
  effectiveSettings(): Settings {
    if (!this.settings.useCoreDailyNote) return this.settings;
    const core = readCoreDailyNoteOptions(this.app);
    if (!core) return this.settings;
    return { ...this.settings, folder: core.folder, filenameTemplate: core.format };
  }

  /** The rendered daily-note template for `date`, or `''` when there is nothing to seed with. */
  private async dailyNoteSeed(date: Date): Promise<string> {
    if (!this.settings.useCoreDailyNote) return '';
    const core = readCoreDailyNoteOptions(this.app);
    if (!core || core.template === '') return '';

    const file = this.templateFile(core.template);
    if (!file) return '';

    const raw = await this.app.vault.cachedRead(file);
    const title = formatDate(core.format, date).split('/').pop() ?? '';
    return renderDailyTemplate(raw, date, formatDate, title);
  }

  /** The core plugin stores the template path with or without `.md`. Try both. */
  private templateFile(path: string): TFile | null {
    for (const candidate of [normalizePath(path), normalizePath(`${path}.md`)]) {
      const f = this.app.vault.getAbstractFileByPath(candidate);
      if (f instanceof TFile) return f;
    }
    return null;
  }

  /** Called by the settings tab after the token changes. */
  async reconnect(): Promise<string> {
    const identity = await this.client.connect();
    return identity.displayName;
  }
}
