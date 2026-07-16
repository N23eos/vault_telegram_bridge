/**
 * Phase 0 spike plugin. THROWAWAY CODE.
 *
 * Not product code, not submitted anywhere, deleted before Phase 1 starts.
 * Everything here exists to answer four questions on real hardware:
 *
 *   0.1  Does gramjs load, connect and read a message inside Obsidian? At what
 *        cost in bundle size, onload time and memory? What happens to the
 *        WebSocket when the app is backgrounded?
 *   0.2  How does `%%tg:a:b%%` render across Reading View / Live Preview /
 *        Source mode / PDF export, and does it break lists and checkboxes?
 *   0.3  How long does PBKDF2 600k take on this device?
 *
 * Run it, click the buttons, copy the results into docs/SPIKE-REPORT.md.
 * The manual procedure is in docs/MANUAL-TEST-GUIDE.md.
 */

import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, normalizePath } from 'obsidian';
import { benchmarkKdf, calibrateIterations, decryptSession, encryptSession, WrongPassphraseError } from './session-crypto';
import { DEDUPE_TEST_NOTE } from './dedupe-fixture';

interface SpikeCreds {
  apiId: string;
  apiHash: string;
}

interface SpikeData {
  creds: SpikeCreds;
  log: string[];
}

const DEFAULT_DATA: SpikeData = { creds: { apiId: '', apiHash: '' }, log: [] };

export default class SpikePlugin extends Plugin {
  data: SpikeData = DEFAULT_DATA;
  private onloadStart = 0;

  async onload() {
    this.onloadStart = performance.now();
    this.data = Object.assign({}, DEFAULT_DATA, (await this.loadData()) as Partial<SpikeData> | null);
    this.addSettingTab(new SpikeSettingsTab(this.app, this));
    this.log(`plugin onload (shell only, gramjs not yet imported): ${(performance.now() - this.onloadStart).toFixed(1)} ms`);
  }

  onunload() {
    // Spike has no long-lived resources of its own; the gramjs client is
    // disconnected explicitly in runGramjsSpike().
  }

  log(line: string) {
    const stamped = `[${new Date().toISOString()}] ${line}`;
    this.data.log.push(stamped);
    void this.saveData(this.data);
  }

  /* ---------------- 0.1 ---------------- */

  /**
   * Dynamic import: measures gramjs parse+evaluate cost separately from the
   * plugin shell. In the real plugin this is exactly how we would lazy-load it
   * so that a user who never connects Telegram pays nothing at startup.
   */
  async runGramjsSpike(phone: () => Promise<string>, code: () => Promise<string>, password: () => Promise<string>) {
    const { apiId, apiHash } = this.data.creds;
    if (!apiId || !apiHash) {
      new Notice('Set api_id / api_hash first');
      return;
    }

    const heapBefore = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;

    const tImport = performance.now();
    const { TelegramClient } = await import('telegram');
    const { StringSession } = await import('telegram/sessions');
    const importMs = performance.now() - tImport;
    this.log(`gramjs dynamic import + evaluate: ${importMs.toFixed(1)} ms`);

    const tCtor = performance.now();
    const client = new TelegramClient(new StringSession(''), Number(apiId), apiHash, {
      connectionRetries: 2,
      // Browser build defaults to wss://<dc>.web.telegram.org/apiws — see report 0.1-F3.
    });
    this.log(`TelegramClient construct: ${(performance.now() - tCtor).toFixed(1)} ms`);

    try {
      const tLogin = performance.now();
      await client.start({
        phoneNumber: phone,
        phoneCode: code,
        password,
        onError: (e) => {
          this.log(`login error: ${e.message}`);
        },
      });
      this.log(`login round-trip: ${((performance.now() - tLogin) / 1000).toFixed(1)} s`);

      const tFetch = performance.now();
      const msgs = await client.getMessages('me', { limit: 1 });
      this.log(`getMessages('me', limit 1): ${(performance.now() - tFetch).toFixed(0)} ms, got ${msgs.length}`);
      // Never log message content — TZ §8. Shape only.
      const m = msgs[0];
      if (m) this.log(`message shape: id=${m.id} date=${m.date} textLen=${(m.message ?? '').length}`);

      const heapAfter = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
      if (heapBefore && heapAfter) {
        this.log(`JS heap delta: ${((heapAfter - heapBefore) / 1048576).toFixed(1)} MB`);
      } else {
        this.log('JS heap delta: performance.memory unavailable (expected on iOS/WebKit)');
      }

      new Notice('gramjs spike OK — check the log');
    } finally {
      // WebSocket must not survive the spike; leaking it would poison the
      // "does the socket die on background?" observation.
      await client.disconnect();
      await client.destroy();
      this.log('client disconnected + destroyed');
    }
  }

  /* ---------------- 0.3 ---------------- */

  async runCryptoSpike() {
    const secret = 'STRING_SESSION_PLACEHOLDER_' + 'x'.repeat(350); // ~ real StringSession length
    const pass = 'correct horse battery staple';

    for (const iters of [210_000, 310_000, 600_000]) {
      const b = await benchmarkKdf(iters, 3);
      this.log(`PBKDF2 ${iters}: median ${b.medianMs.toFixed(0)} ms (samples ${b.samples.map((s) => s.toFixed(0)).join('/')})`);
    }

    const cal = await calibrateIterations();
    this.log(`calibrated: ${cal.iterations} iters @ ${cal.measuredMs.toFixed(0)} ms, within budget: ${cal.belowBudget}`);

    const file = await encryptSession(secret, pass, cal.iterations);
    const roundtrip = await decryptSession(file, pass);
    this.log(`roundtrip identical: ${roundtrip === secret}`);
    this.log(`file size on disk: ${JSON.stringify(file).length} bytes`);

    try {
      await decryptSession(file, pass + '!');
      this.log('FAIL: wrong passphrase decrypted');
    } catch (e) {
      this.log(`wrong passphrase rejected: ${e instanceof WrongPassphraseError}`);
    }

    // Two encryptions of the same plaintext must not produce the same ciphertext.
    const again = await encryptSession(secret, pass, cal.iterations);
    this.log(`iv unique: ${again.iv !== file.iv}, salt unique: ${again.salt !== file.salt}, ct differs: ${again.ct !== file.ct}`);

    // Write through Vault.adapter into configDir — never a hardcoded ".obsidian".
    const dir = normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
    const path = normalizePath(`${dir}/telegram-session.json.enc`);
    await this.app.vault.adapter.write(path, JSON.stringify(file));
    this.log(`wrote ${path} via Vault.adapter (mobile-safe, no fs)`);
    await this.app.vault.adapter.remove(path);
    this.log('wiped session file');

    new Notice('crypto spike done — check the log');
  }

  /* ---------------- 0.2 ---------------- */

  async createDedupeTestNote() {
    const path = normalizePath('TG-SPIKE-dedupe-render-test.md');
    if (await this.app.vault.adapter.exists(path)) {
      await this.app.vault.adapter.write(path, DEDUPE_TEST_NOTE);
    } else {
      await this.app.vault.create(path, DEDUPE_TEST_NOTE);
    }
    new Notice(`Created ${path} — open it in each view mode`);
    this.log(`created dedupe fixture at ${path}`);
  }
}

/* -------------------------------------------------------------------- */

class SpikeSettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: SpikePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('p', {
      text: 'Phase 0 spike build. Throwaway. Use a throwaway Telegram account if you can.',
    });

    new Setting(containerEl)
      .setName('api_id')
      .setDesc('From my.telegram.org. Stored in this spike’s data.json — do not commit it.')
      .addText((t) =>
        t.setValue(this.plugin.data.creds.apiId).onChange(async (v) => {
          this.plugin.data.creds.apiId = v.trim();
          await this.plugin.saveData(this.plugin.data);
        }),
      );

    new Setting(containerEl).setName('api_hash').addText((t) =>
      t.setValue(this.plugin.data.creds.apiHash).onChange(async (v) => {
        this.plugin.data.creds.apiHash = v.trim();
        await this.plugin.saveData(this.plugin.data);
      }),
    );

    new Setting(containerEl)
      .setName('Spike 0.1 — gramjs login + read Saved Messages')
      .addButton((b) =>
        b.setButtonText('Run').setCta().onClick(() =>
          this.plugin.runGramjsSpike(
            () => promptFor(this.app, 'Phone number (+7...)'),
            () => promptFor(this.app, 'Login code from Telegram'),
            () => promptFor(this.app, '2FA password (blank if none)'),
          ),
        ),
      );

    new Setting(containerEl)
      .setName('Spike 0.3 — WebCrypto benchmark + roundtrip')
      .addButton((b) => b.setButtonText('Run').onClick(() => this.plugin.runCryptoSpike()));

    new Setting(containerEl)
      .setName('Spike 0.2 — create dedupe render test note')
      .addButton((b) => b.setButtonText('Create').onClick(() => this.plugin.createDedupeTestNote()));

    new Setting(containerEl).setName('Copy log').addButton((b) =>
      b.setButtonText('Copy').onClick(async () => {
        await navigator.clipboard.writeText(this.plugin.data.log.join('\n'));
        new Notice('Log copied');
      }),
    );

    const pre = containerEl.createEl('pre');
    pre.setCssStyles({ maxHeight: '300px', overflow: 'auto', fontSize: '11px' });
    pre.setText(this.plugin.data.log.slice(-40).join('\n') || '(empty)');
  }
}

function promptFor(app: App, label: string): Promise<string> {
  return new Promise((resolve) => {
    const modal = new (class extends Modal {
      value = '';
      onOpen() {
        this.titleEl.setText(label);
        new Setting(this.contentEl).addText((t) => t.onChange((v) => (this.value = v)));
        new Setting(this.contentEl).addButton((b) =>
          b.setButtonText('OK').setCta().onClick(() => this.close()),
        );
      }
      onClose() {
        resolve(this.value);
      }
    })(app);
    modal.open();
  });
}
