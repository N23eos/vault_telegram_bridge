/**
 * Runs from `npm version <patch|minor|major>` (see the "version" script in
 * package.json). npm has already bumped package.json at this point; this
 * script copies the new version into manifest.json and versions.json so the
 * git tag, the manifest, and the catalog mapping can never diverge.
 */
import { readFileSync, writeFileSync } from "node:fs";

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
  console.error("Run this via `npm version <patch|minor|major>`.");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");

// Stamp the version into styles.css so every release ships unique bytes.
// Identical bytes across releases collect multiple provenance attestations
// on one digest, which the plugin directory verifier rejects.
const styles = readFileSync("styles.css", "utf8");
writeFileSync(
  "styles.css",
  styles.replace(/^\/\* Vault Telegram Bridge .* \*\//, `/* Vault Telegram Bridge ${targetVersion} */`),
);
