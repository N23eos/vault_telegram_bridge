# Obsidian Community directory submission — 0.3.0

Checked against the Obsidian developer documentation on 2026-07-16.

## Repository readiness

- [x] Public GitHub repository with readable TypeScript source
- [x] `README.md`, `LICENSE`, `manifest.json` in the repository root
- [x] Unique plugin id without `obsidian`: `vault-telegram-bridge`
- [x] Semantic version in `x.y.z` form: `0.3.0`
- [x] Matching `package.json`, `manifest.json` and `versions.json`
- [x] Network use, stored secrets and optional third-party STT disclosed in README
- [x] Desktop and mobile compatible (`isDesktopOnly: false`, no Node/Electron runtime API)
- [ ] Manual smoke-test on desktop and mobile with a real Telegram bot
- [ ] Manual STT test against the intended provider

## Release and submission (requires maintainer action)

1. Merge `dev` into the default branch and ensure the default branch contains
   the final `manifest.json` and README.
2. Create and push tag `0.3.0` (no `v` prefix). The existing release workflow
   builds and attaches `main.js`, `manifest.json` and `styles.css`.
3. Confirm the GitHub release tag exactly matches `manifest.json.version` and
   all three assets are downloadable.
4. Sign in at <https://community.obsidian.md>, link the GitHub account, select
   **Plugins → New plugin**, and submit
   `https://github.com/n23eos/vault_telegram_bridge`.
5. Address automated review feedback by incrementing the version and publishing
   a new matching GitHub release.

The current submission flow is through the Obsidian Community directory UI;
new plugins are no longer submitted by opening a hand-written pull request to
`obsidianmd/obsidian-releases`.
