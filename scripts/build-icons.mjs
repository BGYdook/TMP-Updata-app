import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executablePath = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((candidate) => candidate && existsSync(candidate));
if (!executablePath)
  throw new Error("请安装 Chrome / Edge，或设置 CHROME_PATH");

const svg = await fs.readFile(path.join(root, "public/app-icon.svg"), "utf8");
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.setContent(
    `<style>html,body{margin:0;width:100%;height:100%;background:transparent}svg{display:block;width:100%;height:100%}</style>${svg}`,
  );
  await page.setViewportSize({ width: 512, height: 512 });
  await page.screenshot({
    path: path.join(root, "public/app-icon.png"),
    omitBackground: true,
  });

  // Modern Windows supports PNG-compressed RGBA entries in ICO files.
  const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
  const frames = [];
  for (const size of sizes) {
    await page.setViewportSize({ width: size, height: size });
    const png = await page.screenshot({ omitBackground: true });
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
    frames.push(png);
  }
  const directory = Buffer.alloc(6 + 16 * sizes.length);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(sizes.length, 4);
  let offset = directory.length;
  sizes.forEach((size, index) => {
    const entry = 6 + index * 16;
    directory[entry] = size === 256 ? 0 : size;
    directory[entry + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(frames[index].length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += frames[index].length;
  });
  const icon = path.join(root, "public/app-icon.ico");
  await fs.writeFile(icon, Buffer.concat([directory, ...frames]));
  console.log(`Generated ${icon} (${sizes.join(", ")} px) and 512 px PNG`);
} finally {
  await browser.close();
}
