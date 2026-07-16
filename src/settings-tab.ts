import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type { SettingDefinitionItem, SettingGroupItem } from 'obsidian';
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

/** The slider covers the everyday range; the settings schema allows more. */
const SLIDER_MAX_SECONDS = 300;
const SLIDER_STEP_SECONDS = 15;

/**
 * SPEC §6, MVP screen. Connect, destination, sync, status. Nothing else.
 *
 * Declarative definitions (Obsidian ≥ 1.13) so every setting is reachable
 * from the settings search. Rows the declarative controls cannot express —
 * password inputs, composite route rows, the live preview, buttons with
 * side effects — fall back to `render`.
 */
export class SettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: TelegramInboxPlugin,
  ) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      ...this.connectionItems(),
      this.destinationGroup(),
      this.routesList(),
      this.formatGroup(),
      this.transcriptionGroup(),
      this.syncGroup(),
    ];
  }

  getControlValue(key: string): unknown {
    const s = this.plugin.settings;
    if (key === 'syncIntervalSeconds') return Math.min(s.syncIntervalSeconds, SLIDER_MAX_SECONDS);
    return (s as unknown as Record<string, unknown>)[key];
  }

  /**
   * A value that cannot be used as-is is not persisted — same policy the
   * imperative tab had. Persisting garbage would break the next sync pass.
   */
  async setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.plugin.settings;
    switch (key) {
      case 'useCoreDailyNote':
        s.useCoreDailyNote = Boolean(value);
        break;
      case 'folder':
        s.folder = stripSlashes(String(value));
        break;
      case 'heading': {
        const next = String(value).trim();
        if (next === '') return;
        s.heading = next;
        break;
      }
      case 'lineTemplate': {
        if (String(value).trim() === '') return;
        s.lineTemplate = String(value).replace(/\n/g, ' ').trimEnd();
        break;
      }
      case 'blockStyle':
        s.blockStyle = value as BlockStyle;
        break;
      case 'calloutType': {
        const next = String(value).trim();
        if (!/^[A-Za-z-]+$/.test(next)) return;
        s.calloutType = next;
        break;
      }
      case 'transcriptionEnabled':
        s.transcriptionEnabled = Boolean(value);
        break;
      case 'transcriptionModel': {
        const next = String(value).trim();
        if (next === '') return;
        s.transcriptionModel = next;
        break;
      }
      case 'syncIntervalSeconds':
        s.syncIntervalSeconds = Math.min(
          Math.max(Number(value), MIN_SYNC_INTERVAL_SECONDS),
          MAX_SYNC_INTERVAL_SECONDS,
        );
        break;
      default:
        return;
    }
    await this.plugin.saveSettings();
    if (key === 'syncIntervalSeconds') this.plugin.restartTimer();
    if (key === 'lineTemplate' || key === 'blockStyle' || key === 'calloutType') this.refreshPreview();
    // Several rows show or hide depending on the value just written.
    this.refreshDomState();
  }

  /* ---------------- connection ---------------- */

  private connectionItems(): SettingDefinitionItem[] {
    const s = this.plugin.settings;
    return [
      {
        name: t('settings.token.name'),
        desc: t('settings.token.desc'),
        render: (setting) => this.renderTokenRow(setting),
      },
      {
        name: t('settings.disconnect.name'),
        desc: t('settings.disconnect.desc'),
        visible: () => this.plugin.client.status() === 'connected' || s.botToken !== '',
        render: (setting) => this.renderDisconnectRow(setting),
      },
      {
        name: t('settings.boundChat.name'),
        desc: t('settings.boundChat.desc'),
        render: (setting) => this.renderBoundChatRow(setting),
      },
    ];
  }

  private renderTokenRow(setting: Setting): void {
    const s = this.plugin.settings;
    setting
      .addText((text) => {
        text
          .setPlaceholder(t('settings.token.placeholder'))
          .setValue(s.botToken)
          .onChange(async (v) => {
            s.botToken = v.trim();
            await this.plugin.saveSettings();
            this.refreshDomState();
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
            this.update();
          }),
      );
  }

  private renderDisconnectRow(setting: Setting): void {
    const s = this.plugin.settings;
    setting.addButton((b) =>
      b
        .setButtonText(t('settings.disconnect.button'))
        .setDestructive()
        .onClick(async () => {
          await this.plugin.client.wipe();
          s.botToken = '';
          s.boundChatId = null;
          s.cursor = undefined;
          await this.plugin.saveSettings();
          new Notice(t('settings.disconnect.done'));
          this.update();
        }),
    );
  }

  private renderBoundChatRow(setting: Setting): void {
    const s = this.plugin.settings;
    if (s.boundChatId) {
      setting.addExtraButton((b) =>
        b
          .setIcon('rotate-ccw')
          .setTooltip(t('settings.boundChat.reset'))
          .onClick(async () => {
            s.boundChatId = null;
            await this.plugin.saveSettings();
            new Notice(t('settings.boundChat.resetDone'));
            this.update();
          }),
      );
      setting.descEl.createDiv({
        text: t('settings.boundChat.bound', { chatId: s.boundChatId }),
        cls: 'mod-success',
      });
    } else {
      setting.descEl.createDiv({ text: t('settings.boundChat.none') });
    }
  }

  /* ---------------- destination ---------------- */

  private destinationGroup(): SettingDefinitionItem {
    const s = this.plugin.settings;
    const items: SettingGroupItem[] = [
      {
        name: t('settings.coreDaily.name'),
        desc: t('settings.coreDaily.desc'),
        control: { type: 'toggle', key: 'useCoreDailyNote' },
      },
      {
        name: '',
        searchable: false,
        visible: () => s.useCoreDailyNote && readCoreDailyNoteOptions(this.app) === null,
        render: (setting) => {
          setting.setDesc(t('settings.coreDaily.unavailable'));
          setting.descEl.addClass('mod-warning');
        },
      },
      {
        name: t('settings.folder.name'),
        desc: t('settings.folder.desc'),
        visible: () => !s.useCoreDailyNote,
        control: { type: 'text', key: 'folder', placeholder: t('settings.folder.placeholder') },
      },
      {
        name: t('settings.filename.name'),
        visible: () => !s.useCoreDailyNote,
        render: (setting) => this.renderFilenameRow(setting),
      },
      {
        name: t('settings.heading.name'),
        desc: t('settings.heading.desc'),
        control: { type: 'text', key: 'heading' },
      },
    ];
    return { type: 'group', heading: t('settings.section.destination'), items };
  }

  private renderFilenameRow(setting: Setting): void {
    const s = this.plugin.settings;
    const updatePreview = () => {
      setting.setDesc(t('settings.filename.desc', { preview: this.previewPath() }));
    };
    updatePreview();

    setting.addText((text) =>
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

  /* ---------------- routes ---------------- */

  private routesList(): SettingDefinitionItem {
    const s = this.plugin.settings;
    return {
      type: 'list',
      heading: t('settings.section.routes'),
      emptyState: t('settings.routes.desc'),
      items: s.routes.map((route) => ({
        name: `#${route.tag}`,
        searchable: false,
        render: (setting: Setting) => this.renderRouteRow(setting, route),
      })),
      onDelete: (index) => {
        void (async () => {
          s.routes.splice(index, 1);
          await this.plugin.saveSettings();
          this.update();
        })();
      },
      addItem: {
        name: t('settings.routes.add'),
        action: () => {
          void (async () => {
            s.routes.push({ tag: 'tag', notePath: 'Inbox.md' });
            await this.plugin.saveSettings();
            this.update();
          })();
        },
      },
    };
  }

  private renderRouteRow(
    setting: Setting,
    route: { tag: string; notePath: string; heading?: string },
  ): void {
    setting
      .addText((text) => {
        const mark = () => text.inputEl.toggleClass('vtb-invalid', !HASHTAG_SHAPE.test(route.tag));
        text
          .setPlaceholder(t('settings.routes.tag.placeholder'))
          .setValue(route.tag)
          .onChange(async (value) => {
            route.tag = value.trim().replace(/^#/, '').toLowerCase();
            setting.setName(`#${route.tag}`);
            mark();
            await this.plugin.saveSettings();
          });
        mark();
      })
      .addText((text) => {
        const mark = () => text.inputEl.toggleClass('vtb-invalid', !isValidRoutePath(route.notePath));
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
      );
  }

  /* ---------------- format ---------------- */

  private formatGroup(): SettingDefinitionItem {
    const s = this.plugin.settings;
    const items: SettingGroupItem[] = [
      {
        name: t('settings.template.name'),
        desc: t('settings.template.desc'),
        control: { type: 'text', key: 'lineTemplate', placeholder: t('settings.template.placeholder') },
      },
      {
        name: t('settings.blockStyle.name'),
        control: {
          type: 'dropdown',
          key: 'blockStyle',
          options: Object.fromEntries(
            BLOCK_STYLES.map((style) => [style, t(`settings.blockStyle.${style}`)]),
          ),
        },
      },
      {
        name: '',
        searchable: false,
        visible: () => s.blockStyle === 'code',
        render: (setting) => {
          setting.setDesc(t('settings.blockStyle.codeWarning'));
        },
      },
      {
        name: t('settings.calloutType.name'),
        desc: t('settings.calloutType.desc'),
        visible: () => s.blockStyle === 'callout',
        control: { type: 'text', key: 'calloutType' },
      },
      {
        name: t('settings.preview.name'),
        render: (setting) => {
          this.previewEl?.remove();
          this.previewEl = setting.controlEl.createEl('pre', { cls: 'telegram-inbox-preview' });
          this.refreshPreview();
          return () => {
            this.previewEl = null;
          };
        },
      },
      {
        name: '',
        searchable: false,
        visible: () => !s.lineTemplate.includes('{text}'),
        render: (setting) => {
          setting.setDesc(t('error.noTextPlaceholder'));
          setting.descEl.addClass('mod-warning');
        },
      },
    ];
    return { type: 'group', heading: t('settings.section.format'), items };
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

  /* ---------------- transcription ---------------- */

  private transcriptionGroup(): SettingDefinitionItem {
    const s = this.plugin.settings;
    const enabled = () => s.transcriptionEnabled;
    const items: SettingGroupItem[] = [
      {
        name: t('settings.transcription.name'),
        desc: t('settings.transcription.desc'),
        control: { type: 'toggle', key: 'transcriptionEnabled' },
      },
      {
        name: '',
        searchable: false,
        visible: enabled,
        render: (setting) => {
          setting.descEl.createDiv({ text: t('settings.transcription.hint.groq') });
          setting.descEl.createDiv({ text: t('settings.transcription.hint.openai') });
        },
      },
      {
        name: t('settings.transcription.baseUrl.name'),
        desc: t('settings.transcription.baseUrl.desc'),
        visible: enabled,
        render: (setting) => this.renderBaseUrlRow(setting),
      },
      {
        name: t('settings.transcription.apiKey.name'),
        desc: t('settings.transcription.apiKey.desc'),
        visible: enabled,
        render: (setting) => this.renderApiKeyRow(setting),
      },
      {
        name: t('settings.transcription.model.name'),
        desc: t('settings.transcription.model.desc'),
        visible: enabled,
        control: { type: 'text', key: 'transcriptionModel' },
      },
      {
        name: t('settings.transcription.test.name'),
        desc: t('settings.transcription.test.desc'),
        visible: enabled,
        render: (setting) => this.renderTestRow(setting),
      },
    ];
    return { type: 'group', heading: t('settings.section.transcription'), items };
  }

  private renderBaseUrlRow(setting: Setting): void {
    const s = this.plugin.settings;
    setting.addText((text) =>
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
  }

  private renderApiKeyRow(setting: Setting): void {
    const s = this.plugin.settings;
    setting.addText((text) => {
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
  }

  private renderTestRow(setting: Setting): void {
    const s = this.plugin.settings;
    setting.addButton((button) =>
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

  private syncGroup(): SettingDefinitionItem {
    const items: SettingGroupItem[] = [
      {
        name: t('settings.interval.name'),
        desc: t('settings.interval.desc'),
        control: {
          type: 'slider',
          key: 'syncIntervalSeconds',
          min: MIN_SYNC_INTERVAL_SECONDS,
          max: SLIDER_MAX_SECONDS,
          step: SLIDER_STEP_SECONDS,
        },
      },
      {
        name: t('settings.syncNow.name'),
        render: (setting) => {
          setting.addButton((b) =>
            b.setButtonText(t('settings.syncNow.button')).onClick(async () => {
              await this.plugin.syncNow('manual');
              this.update();
            }),
          );
        },
      },
      { name: t('settings.status.name'), desc: this.statusText() },
    ];
    return { type: 'group', heading: t('settings.section.sync'), items };
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
