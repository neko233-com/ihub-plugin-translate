import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceHtmlPath = resolve(projectRoot, "src", "index.html");
const distributionDir = resolve(projectRoot, "dist");
const sourceHtml = await readFile(sourceHtmlPath, "utf8");

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
