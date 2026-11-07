import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(new URL("../electron/main.cjs", import.meta.url));
const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tmp-app-update-"));
const handlers = new Map();
const launched = [];
const progress = [];
const content = Buffer.from("isolated installer fixture");
const version = "99.0.0";
const assetName = `TMP-Update-${version}-Setup.exe`;
const downloadUrl = `https://cnb.cool/test/${assetName}`;
let invalidChecksum = false;
let rangeRequested = false;
const sender = {
  isDestroyed: () => false,
  send: (_channel, value) => progress.push(value),
  mainFrame: { url: "http://127.0.0.1:5173/" },
};

try {
  const electron = {
    app: {
      requestSingleInstanceLock: () => false,
      quit() {},
      on() {},
      getPath: () => root,
      getVersion: () => "1.0.0",
    },
    protocol: { registerSchemesAsPrivileged() {} },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    shell: { openPath: async (installer) => { launched.push(installer); return ""; } },
    net: {
      fetch: async (url, options) => {
        if (url === `${downloadUrl}.sha256`) {
          const checksum = invalidChecksum ? "0".repeat(64) : crypto.createHash("sha256").update(content).digest("hex");
          return new Response(`${checksum}  ${assetName}`);
        }
        assert.equal(url, downloadUrl);
        const offset = Number(options.headers.Range?.match(/^bytes=(\d+)-$/)?.[1] || 0);
        rangeRequested ||= offset > 0;
        return new Response(content.subarray(offset), {
          status: offset ? 206 : 200,
          headers: {
            "content-length": String(content.length - offset),
            ...(offset ? { "content-range": `bytes ${offset}-${content.length - 1}/${content.length}` } : {}),
          },
        });
      },
    },
  };
  const context = vm.createContext({
    require: (name) => name === "electron" ? electron : require(name),
    // Web Crypto has no createHash: this reproduces the original missing import.
    crypto: crypto.webcrypto,
    process, Buffer, URL, Response, console,
    setTimeout: () => 0,
    setInterval: () => 0,
    clearInterval() {},
  });
  vm.runInContext(await fsp.readFile(new URL("../electron/main.cjs", import.meta.url), "utf8"), context);
  context.testSender = sender;
  context.testRelease = { version, assetName, downloadUrl, checksumUrl: `${downloadUrl}.sha256` };
  vm.runInContext(`
    mainWindow = { isDestroyed: () => false, webContents: testSender };
    tmpUpdate = { updating: false };
    pendingAppUpdate = testRelease;
  `, context);
  const install = handlers.get("tmp:install-app-update");
  const event = { sender, senderFrame: sender.mainFrame };
  const installer = path.join(root, "updates", assetName);
  const temporary = path.join(root, "updates", `.${assetName}.part`);

  const first = await install(event);
  assert.equal(first.ok, true, first.message);
  assert.deepEqual(await fsp.readFile(installer), content);
  assert.equal(launched.length, 1);
  assert.equal(progress.some((value) => value.phase === "verifying"), true);

  await fsp.writeFile(temporary, content.subarray(0, 7));
  const resumed = await install(event);
  assert.equal(resumed.ok, true, resumed.message);
  assert.equal(rangeRequested, true);
  assert.deepEqual(await fsp.readFile(installer), content);
  assert.equal(launched.length, 2);

  invalidChecksum = true;
  const rejected = await install(event);
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /SHA-256/);
  assert.equal(launched.length, 2);
  assert.deepEqual(await fsp.readFile(installer), content);
  await assert.rejects(fsp.stat(temporary), { code: "ENOENT" });
  console.log("PASS: installer download, SHA-256 verification, simulated launch, resumed download and corrupt checksum rejection");
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}
