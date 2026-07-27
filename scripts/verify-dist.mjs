import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFile(resolve(projectRoot, relativePath), "utf8");
const manifestText = await read("plugin.json");
const manifest = JSON.parse(manifestText);
const source = await read("src/main.ts");
const html = await read("dist/index.html");
const main = await read("dist/main.js");

const exactNetworkPermission = ["user-configured HTTPS LibreTranslate-compatible endpoint"];
if (
  manifest.version !== "1.0.1"
  || manifest.entry?.frontend !== "dist/index.html"
  || JSON.stringify(manifest.permissions?.network?.allow) !== JSON.stringify(exactNetworkPermission)
  || manifest.permissions?.clipboard?.write !== true
  || Object.keys(manifest.permissions?.clipboard ?? {}).length !== 1
  || Object.keys(manifest.permissions ?? {}).sort().join(",") !== "clipboard,network"
  || manifest.update?.channel !== "stable"
  || manifest.update?.autoUpdate !== true
) {
  throw new Error("Manifest must expose the documented network/clipboard permissions and stable update-check channel.");
}

for (const requiredMarkup of [
  'id="endpoint"',
  'id="api-key"',
  'id="source-text"',
  'id="translated-text"',
  'id="translate"',
  'id="copy"',
  'src="./main.js"',
]) {
  if (!html.includes(requiredMarkup)) {
    throw new Error("Built HTML is missing required markup: " + requiredMarkup);
  }
}
if (/<(?:script|link)\b[^>]+https?:\/\//i.test(html)) {
  throw new Error("Built HTML must not load remote scripts or styles.");
}
for (const forbidden of ["localStorage", "sessionStorage", "settings.set", "clipboard.readText"]) {
  if (source.includes(forbidden) || main.includes(forbidden)) {
    throw new Error("Translation frontend must not persist secrets or read clipboard text: " + forbidden);
  }
}
for (const requiredApi of [
  "LibreTranslate",
  "credentials: \"omit\"",
  "referrerPolicy: \"no-referrer\"",
  "clipboard.writeText",
  "apiKey.value = \"\"",
  "https:",
]) {
  if (!main.includes(requiredApi)) {
    throw new Error("Built browser bundle is missing: " + requiredApi);
  }
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
console.log(JSON.stringify({
  plugin: manifest.id + "@" + manifest.version,
  manifestSha256: sha256(manifestText),
  artifacts: {
    "dist/index.html": sha256(html),
    "dist/main.js": sha256(main),
  },
}, null, 2));
