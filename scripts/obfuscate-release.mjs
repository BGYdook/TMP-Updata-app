import fs from "node:fs/promises";
import path from "node:path";
import JavaScriptObfuscator from "javascript-obfuscator";

const root = process.cwd();
const browserOptions = {
  target: "browser",
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.62,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.16,
  disableConsoleOutput: true,
  identifierNamesGenerator: "hexadecimal",
  numbersToExpressions: true,
  renameGlobals: false,
  selfDefending: true,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 8,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayEncoding: ["base64", "rc4"],
  stringArrayIndexesType: ["hexadecimal-number"],
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayThreshold: 0.86,
  transformObjectKeys: true,
  unicodeEscapeSequence: false,
};

const nodeOptions = {
  ...browserOptions,
  target: "node",
  controlFlowFlatteningThreshold: 0.35,
  deadCodeInjectionThreshold: 0.08,
  selfDefending: false,
  stringArrayThreshold: 0.72,
};

async function obfuscate(sourcePath, outputPath, options) {
  const source = await fs.readFile(sourcePath, "utf8");
  const result = JavaScriptObfuscator.obfuscate(source, options).getObfuscatedCode();
  await fs.writeFile(outputPath, result, "utf8");
}

const assetsDir = path.join(root, "dist", "assets");
const assets = await fs.readdir(assetsDir);
const scripts = assets.filter((name) => name.endsWith(".js"));
if (!scripts.length) throw new Error("No renderer JavaScript assets were found");

for (const name of scripts) {
  const fullPath = path.join(assetsDir, name);
  await obfuscate(fullPath, fullPath, browserOptions);
}

const electronDir = path.join(root, "electron");
await Promise.all([
  obfuscate(
    path.join(electronDir, "main.cjs"),
    path.join(electronDir, "main.release.cjs"),
    nodeOptions,
  ),
  obfuscate(
    path.join(electronDir, "preload.cjs"),
    path.join(electronDir, "preload.release.cjs"),
    nodeOptions,
  ),
  obfuscate(
    path.join(electronDir, "tmp-update.cjs"),
    path.join(electronDir, "tmp-update.release.cjs"),
    nodeOptions,
  ),
]);

console.log(`Obfuscated ${scripts.length} renderer bundle(s) and 3 Electron modules.`);
