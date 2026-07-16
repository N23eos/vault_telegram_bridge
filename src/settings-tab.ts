import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import { HumanError } from './errors';
import { t } from './i18n';
import type TelegramInboxPlugin from './main';
import { formatDate } from './main';
import {
  BLOCK_STYLES,
  HASHTAG_SHAPE,
  looksLikeBotToken,
  MAX_SYNC_INTERVAL_SECONDS,
  MIN_SYNC_INTERVAL_SECONDS,
  normalizeHttpUrl,
  stripSlashes,
} from './settings';
import { joinEntries, renderEntry, type BlockStyle } from './sync/render';
import { isValidRoutePath } from './sync/routing';
import { OpenAITranscriber, silentWav } from './transcription';
import { readCoreDailyNoteOptions } from './vault/core-daily-notes';
import { resolveDailyNotePath } from './vault/daily-note';

/** SPEC §6, MVP screen. Connect, destination, sync, status. Nothing else. */
export class SettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: TelegramInboxPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderConnection(containerEl);
    this.renderDestination(containerEl);
    this.renderRoutes(containerEl);
    this.renderFormat(containerEl);
    this.renderTranscription(containerEl);
    this.renderSync(containerEl);
  }

  private renderRoutes(root: HTMLElement): void {
    const s = this.plugin.settings;
    new Setting(root).setName(t('settings.section.routes')).setHeading();
    root.createDiv({ text: t('settings.routes.desc'), cls: 'setting-item-description' });

    s.routes.forEach((route, index) => {
      new Setting(root)
        .setName(`#${route.tag}`)
        .addText((text) => {
          const mark = () =>
            text.inputEl.toggleClass('vtb-invalid', !HASHTAG_SHAPE.test(route.tag));
          text
            .setPlaceholder(t('settings.routes.tag.placeholder'))
            .setValue(route.tag)
            .onChange(async (value) => {
              route.tag = value.trim().replace(/^#/, '').toLowerCase();
              mark();
              await this.plugin.saveSettings();
            });
          mark();
        })
        .addText((text) => {
          const mark = () =>
            text.inputEl.toggleClass('vtb-invalid', !isValidRoutePath(route.notePath));
          text
            .setPlaceholder(t('settings.routes.path.placeholder'))
            .setValue(route.notePath)
            .onChange(async (value) => {
              route.notePath = stripSlashes(value);
              mark();
              await this.plugin.saveSettings();
            });
          mark();
        })
        .addText((text) =>
          text
            .setPlaceholder(t('settings.routes.heading.placeholder'))
            .setValue(route.heading ?? '')
            .onChange(async (value) => {
              const heading = value.trim();
              if (heading === '') delete route.heading;
              else route.heading = heading;
              await this.plugin.saveSettings();
            }),
        )
        .addExtraButton((button) =>
          button
            .setIcon('trash-2')
            .setTooltip(t('settings.routes.remove'))
            .onClick(async () => {
              s.routes.splice(index, 1);
              await this.plugin.saveSettings();
              this.display();
            }),
        );
    });

    new Setting(root).addButton((button) =>
      button.setButtonText(t('settings.routes.add')).onClick(async () => {
        s.routes.push({ tag: 'tag', notePath: 'Inbox.md' });
        await this.plugin.saveSettings();
        this.display();
      }),
    );
  }

  /* ---------------- connection ---------------- */

  private renderConnection(root: HTMLElement): void {
    const s = this.plugin.settings;
    const connected = this.plugin.client.status() === 'connected';

    new Setting(root)
      .setName(t('settings.token.name'))
      .setDesc(t('settings.token.desc'))
      .addText((text) => {
        text
          .setPlaceholder(t('settings.token.placeholder'))
          .setValue(s.botToken)
          .onChange(async (v) => {
            s.botToken = v.trim();
            await this.plugin.saveSettings();
          });
        // A bot token is a credential. Do not render it in the clear next to a
        // screen the user might be sharing.
        text.inputEl.type = 'password';
        text.inputEl.autocomplete = 'off';
      })
      .addButton((b) =>
        b
          .setButtonText(t('settings.token.connect'))
          .setCta()
          .onClick(async () => {
            if (!looksLikeBotToken(s.botToken)) {
              new Notice(t('error.tokenShape'));
              return;
            }
            try {
              const name = await this.plugin.reconnect();
              new Notice(t('settings.token.connected', { name }));
            } catch (e) {
              new Notice(e instanceof HumanError ? e.human : t('error.unknown', { message: String(e) }));
            }
            this.display();
          }),
      );

    if (connected || s.botToken) {
      new Setting(root)
        .setName(t('settings.disconnect.name'))
        .setDesc(t('settings.disconnect.desc'))
        .addButton((b) =>
          b
            .setButtonText(t('settings.disconnect.button'))
            .setWarning()
            .onClick(async () => {
              await this.plugin.client.wipe();
              s.botToken = '';
              s.boundChatId = null;
              s.cursor = undefined;
              await this.plugin.saveSettings();
              new Notice(t('settings.disconnect.done'));
              this.display();
            }),
        );
    }

    const bound = new Setting(root)
      .setName(t('settings.boundChat.name'))
      .setDesc(t('settings.boundChat.desc'));

    if (s.boundChatId) {
      bound.addExtraButton((b) =>
        b
          .setIcon('rotate-ccw')
          .setTooltip(t('settings.boundChat.reset'))
          .onClick(async () => {
            s.boundChatId = null;
            await this.plugin.saveSettings();
            new Notice(t('settings.boundChat.resetDone'));
            this.display();
          }),
      );
      bound.descEl.createDiv({
        text: t('settings.boundChat.bound', { chatId: s.boundChatId }),
        cls: 'mod-success',
      });
    } else {
      bound.descEl.createDiv({ text: t('settings.boundChat.none') });
    }
  }

  /* ---------------- destination ---------------- */

  private renderDestination(root: HTMLElement): void {
    const s = this.plugin.settings;
    new Setting(root).setName(t('settings.section.destination')).setHeading();

    const coreToggle = new Setting(root)
      .setName(t('settings.coreDaily.name'))
      .setDesc(t('settings.coreDaily.desc'))
      .addToggle((toggle) =>
        toggle.setValue(s.useCoreDailyNote).onChange(async (v) => {
          s.useCoreDailyNote = v;
          await this.plugin.saveSettings();
          // The folder and note-name fields appear and vanish.
          this.display();
        }),
      );

    if (s.useCoreDailyNote && readCoreDailyNoteOptions(this.app) === null) {
      coreToggle.descEl.createDiv({ text: t('settings.coreDaily.unavailable'), cls: 'mod-warning' });
    }

    // Folder and note name are the two fields core mode replaces. The heading
    // below is NOT one of them — entries land under it in either mode, so it
    // must stay visible.
    if (!s.useCoreDailyNote) {
      new Setting(root)
        .setName(t('settings.folder.name'))
        .setDesc(t('settings.folder.desc'))
        .addText((text) =>
          text
            .setPlaceholder(t('settings.folder.placeholder'))
            .setValue(s.folder)
            .onChange(async (v) => {
              s.folder = stripSlashes(v);
              await this.plugin.saveSettings();
            }),
        );

      const filename = new Setting(root).setName(t('settings.filename.name'));

      const updatePreview = () => {
        filename.setDesc(t('settings.filename.desc', { preview: this.previewPath() }));
      };
      updatePreview();

      filename.addText((text) =>
        text
          .setPlaceholder(t('settings.filename.placeholder'))
          .setValue(s.filenameTemplate)
          .onChange(async (v) => {
            s.filenameTemplate = v.trim();
            await this.plugin.saveSettings();
            // Live preview is the whole reason a template field is tolerable.
            updatePreview();
          }),
      );
    }

    new Setting(root)
      .setName(t('settings.heading.name'))
      .setDesc(t('settings.heading.desc'))
      .addText((text) =>
        text.setValue(s.heading).onChange(async (v) => {
          const next = v.trim();
          if (next !== '') {
            s.heading = next;
            await this.plugin.saveSettings();
          }
        }),
      );
  }

  /* ---------------- format ---------------- */

  private renderFormat(root: HTMLElement): void {
    const s = this.plugin.settings;
    new Setting(root).setName(t('settings.section.format')).setHeading();

    new Setting(root)
      .setName(t('settings.template.name'))
      .setDesc(t('settings.template.desc'))
      .addText((text) =>
        text
          .setPlaceholder(t('settings.template.placeholder'))
          .setValue(s.lineTemplate)
          .onChange(async (v) => {
            if (v.trim() === '') return;
            s.lineTemplate = v.replace(/\n/g, ' ').trimEnd();
            await this.plugin.saveSettings();
            this.refreshPreview();
          }),
      );

    new Setting(root)
      .setName(t('settings.blockStyle.name'))
      .addDropdown((d) => {
        for (const style of BLOCK_STYLES) d.addOption(style, t(`settings.blockStyle.${style}`));
        d.setValue(s.blockStyle).onChange(async (v) => {
          s.blockStyle = v as BlockStyle;
          await this.plugin.saveSettings();
          // The callout-type field and the code-block warning appear and vanish.
          this.display();
        });
      });

    if (s.blockStyle === 'code') {
      root.createDiv({ text: t('settings.blockStyle.codeWarning'), cls: 'setting-item-description' });
    }

    if (s.blockStyle === 'callout') {
      new Setting(root)
        .setName(t('settings.calloutType.name'))
        .setDesc(t('settings.calloutType.desc'))
        .addText((text) =>
          text.setValue(s.calloutType).onChange(async (v) => {
            if (!/^[A-Za-z-]+$/.test(v.trim())) return;
            s.calloutType = v.trim();
            await this.plugin.saveSettings();
            this.refreshPreview();
          }),
        );
    }

    const preview = new Setting(root).setName(t('settings.preview.name'));
    this.previewEl = preview.controlEl.createEl('pre', { cls: 'telegram-inbox-preview' });
    this.refreshPreview();

    if (!s.lineTemplate.includes('{text}')) {
      root.createDiv({ text: t('error.noTextPlaceholder'), cls: 'mod-warning' });
    }
  }

  /**
   * Two entries, one of them multi-line, so the user sees the separator and the
   * continuation behaviour rather than guessing at them.
   */
  private refreshPreview(): void {
    if (!this.previewEl) return;
    const s = this.plugin.settings;
    const opts = { template: s.lineTemplate, blockStyle: s.blockStyle, calloutType: s.calloutType };
    const entries = [
      renderEntry('an idea on a walk', opts, { time: '15:29', date: '2026-07-08' }),
      renderEntry('a longer one\nspilling onto a second line', opts, { time: '15:30', date: '2026-07-08' }),
    ];
    this.previewEl.setText([s.heading, '', ...joinEntries(entries)].join('\n'));
  }

  private previewEl: HTMLElement | null = null;

  /** Renders today's destination, or the reason the template is unusable. */
  private previewPath(): string {
    try {
      return resolveDailyNotePath(this.plugin.effectiveSettings(), new Date(), formatDate);
    } catch (e) {
      return e instanceof HumanError ? e.human : String(e);
    }
  }

  private renderTranscription(root: HTMLElement): void {
    const s = this.plugin.settings;
    new Setting(root).setName(t('settings.section.transcription')).setHeading();
    new Setting(root)
      .setName(t('settings.transcription.name'))
      .setDesc(t('settings.transcription.desc'))
      .addToggle((toggle) =>
        toggle.setValue(s.transcriptionEnabled).onChange(async (value) => {
          s.transcriptionEnabled = value;
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    if (!s.transcriptionEnabled) return;

    const hint = root.createDiv({ cls: 'setting-item-description' });
    hint.createDiv({ text: t('settings.transcription.hint.groq') });
    hint.createDiv({ text: t('settings.transcription.hint.openai') });

    new Setting(root)
      .setName(t('settings.transcription.baseUrl.name'))
      .setDesc(t('settings.transcription.baseUrl.desc'))
      .addText((text) =>
        text.setValue(s.transcriptionBaseUrl).onChange(async (value) => {
          // Same rule as the loader: https, or http for loopback only. Invalid
          // input is marked, never silently dropped.
          const url = normalizeHttpUrl(value);
          text.inputEl.toggleClass('vtb-invalid', url === null);
          if (url !== null) {
            s.transcriptionBaseUrl = url;
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(root)
      .setName(t('settings.transcription.apiKey.name'))
      .setDesc(t('settings.transcription.apiKey.desc'))
      .addText((text) => {
        text
          .setPlaceholder(t('settings.transcription.apiKey.placeholder'))
          .setValue(s.transcriptionApiKey)
          .onChange(async (value) => {
            s.transcriptionApiKey = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.type = 'password';
        text.inputEl.autocomplete = 'off';
      });

    new Setting(root)
      .setName(t('settings.transcription.model.name'))
      .setDesc(t('settings.transcription.model.desc'))
      .addText((text) =>
        text.setValue(s.transcriptionModel).onChange(async (value) => {
          if (value.trim() !== '') {
            s.transcriptionModel = value.trim();
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(root)
      .setName(t('settings.transcription.test.name'))
      .setDesc(t('settings.transcription.test.desc'))
      .addButton((button) =>
        button.setButtonText(t('settings.transcription.test.button')).onClick(async () => {
          button.setDisabled(true);
          try {
            // Success is a 2xx from the provider; an empty transcript is the
            // expected answer to a fraction of a second of silence.
            await new OpenAITranscriber().transcribe(
              { fileName: 'test.wav', data: silentWav() },
              {
                baseUrl: s.transcriptionBaseUrl,
                apiKey: s.transcriptionApiKey,
                model: s.transcriptionModel,
              },
            );
            new Notice(t('settings.transcription.test.ok'));
          } catch (e) {
            new Notice(e instanceof HumanError ? e.human : String(e));
          } finally {
            button.setDisabled(false);
          }
        }),
      );
  }

  /* ---------------- sync ---------------- */

  private renderSync(root: HTMLElement): void {
    const s = this.plugin.settings;
    new Setting(root).setName(t('settings.section.sync')).setHeading();

    new Setting(root)
      .setName(t('settings.interval.name'))
      .setDesc(t('settings.interval.desc'))
      .addSlider((slider) =>
        slider
          .setLimits(MIN_SYNC_INTERVAL_SECONDS, 300, 15)
          .setValue(Math.min(s.syncIntervalSeconds, 300))
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.syncIntervalSeconds = Math.min(Math.max(v, MIN_SYNC_INTERVAL_SECONDS), MAX_SYNC_INTERVAL_SECONDS);
            await this.plugin.saveSettings();
            this.plugin.restartTimer();
          }),
      );

    new Setting(root)
      .setName(t('settings.syncNow.name'))
      .addButton((b) =>
        b.setButtonText(t('settings.syncNow.button')).onClick(async () => {
          await this.plugin.syncNow('manual');
          this.display();
        }),
      );

    new Setting(root).setName(t('settings.status.name')).setDesc(this.statusText());
  }

  private statusText(): string {
    const { engine, settings } = this.plugin;
    if (engine.isRunning) return t('settings.status.running');

    const last = settings.lastSync;
    if (!last) return t('settings.status.never');

    const time = formatDate('YYYY-MM-DD HH:mm', new Date(last.at));
    if (!last.ok) {
      return t('settings.status.error', {
        time,
        message: engine.error?.human ?? t('error.unknown', { message: last.errorKey ?? '' }),
      });
    }
    return last.count
      ? t('settings.status.ok', { time, n: last.count })
      : t('settings.status.okNothing', { time });
  }
}
