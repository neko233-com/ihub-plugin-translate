import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceHtmlPath = resolve(projectRoot, "src", "index.html");
const distributionDir = resolve(projectRoot, "dist");
const sourceHtml = await readFile(sourceHtmlPath, "utf8");
const manifest = JSON.parse(await readFile(resolve(projectRoot, "plugin.json"), "utf8"));

if (
  manifest.contributes?.commands?.[0]?.id !== "open-translate"
  || manifest.contributes?.commands?.[0]?.execution !== "frontend"
  || manifest.contributes?.commands?.[1]?.id !== "translate-launcher-text"
  || manifest.contributes?.commands?.[1]?.execution !== "frontend"
  || manifest.permissions?.launcherContext?.text !== true
) {
  throw new Error("Translate manifest must declare the explicit text-handoff frontend command and launcherContext.text permission.");
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
  if (!sourceHtml.includes(requiredMarkup)) {
    throw new Error("Translate HTML is missing required markup: " + requiredMarkup);
  }
}

await mkdir(distributionDir, { recursive: true });
await writeFile(resolve(distributionDir, "index.html"), sourceHtml, "utf8");
