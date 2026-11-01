import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright-core";

const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tmp-sync-desktop-"));
const output = path.join(root, "diagnostics.json");
const require = createRequire(import.meta.url);
const executablePath = require("electron");
let desktop;

try {
  desktop = await electron.launch({
    executablePath,
    args: [path.resolve(".")],
    env: { ...process.env, APPDATA: root, LOCALAPPDATA: root },
    timeout: 30_000,
  });
  const page = await desktop.firstWindow();
  await page.getByRole("switch", { name: "关闭窗口后驻留托盘" }).waitFor();
  await desktop.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: process.env.TMP_SYNC_TEST_LOG });
  });
  // The mock save destination is provided only to this isolated app process.
  await desktop.evaluate((_, filePath) => { process.env.TMP_SYNC_TEST_LOG = filePath; }, output);
  const exported = await page.evaluate(() => window.tmpDesktop.exportDiagnostics({
    sourceState: "ready",
    lastScannedAt: "2026-10-31T00:00:00.000Z",
    files: [{ path: "/test.bin", state: "error", error: "test failure" }],
    activities: [{ time: "12:00", level: "error", message: "test failure" }],
  }));
  assert.equal(exported.ok, true);
  const diagnostic = JSON.parse(await fsp.readFile(output, "utf8"));
  assert.equal(diagnostic.appVersion, "1.2.1");
  assert.equal(diagnostic.files[0].error, "test failure");

  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  console.log(JSON.stringify({ trayClose: true, exported: true, version: diagnostic.appVersion }, null, 2));
} finally {
  if (desktop) await desktop.close();
  await fsp.rm(root, { recursive: true, force: true });
}
