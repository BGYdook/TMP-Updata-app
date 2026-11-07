import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TmpUpdateManager, targetPath } = require("../electron/tmp-update.cjs");
const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tmp-sync-native-"));
const installPath = path.join(root, "TruckersMP", "installation");
const configPath = path.join(root, "TruckersMP", "launcher-options.json");
const files = [
  ["/data/current.bin", "current-data"],
  ["/data/outdated.bin", "updated-data"],
  ["/nested/missing.bin", "missing-data"],
].map(([filePath, content]) => ({
  type: 1,
  typeName: "系统",
  md5: crypto.createHash("md5").update(content).digest("hex"),
  fileSize: Buffer.byteLength(content),
  filePath,
  downloadUrl: "",
  updateTime: "2026-10-31 12:00:00",
}));

const payloads = new Map(files.map((file) => [file.filePath, file]));
const progressEvents = [];
const requests = new Map();
let permanentFailure = false;
const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/api/tmp/files") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ code: 200, msg: "ok", data: files }));
    return;
  }
  const file = payloads.get(url.pathname.replace(/^\/files/, ""));
  if (!file) {
    response.writeHead(404).end();
    return;
  }
  const requestCount = (requests.get(file.filePath) || 0) + 1;
  requests.set(file.filePath, requestCount);
  if ((file.filePath === "/nested/missing.bin" && requestCount === 1) ||
      (permanentFailure && file.filePath === "/data/outdated.bin")) {
    response.writeHead(503).end();
    return;
  }
  const content = Buffer.from(
    files.find((item) => item.filePath === file.filePath).filePath === "/data/current.bin"
      ? "current-data"
      : file.filePath === "/data/outdated.bin"
        ? "updated-data"
        : "missing-data",
  );
  response.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": content.length,
  });
  response.end(content);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;
for (const file of files) file.downloadUrl = `${baseUrl}/files${file.filePath}?v=${file.md5}`;

try {
  await fsp.mkdir(path.join(installPath, "data"), { recursive: true });
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, JSON.stringify({ installPath }));
  await fsp.writeFile(path.join(installPath, "data", "current.bin"), "current-data");
  await fsp.writeFile(path.join(installPath, "data", "outdated.bin"), "outdated-old");
  const outsidePath = path.join(root, "outside");
  await fsp.mkdir(outsidePath);
  await fsp.symlink(outsidePath, path.join(installPath, "data", "linked"), "junction");

  const manager = new TmpUpdateManager({
    configPaths: [path.join(root, "missing.json"), configPath],
    backupRoot: path.join(root, "backups"),
    onProgress: (progress) => progressEvents.push(progress),
  });
  const detection = await manager.detectInstallPath();
  assert.equal(detection.ok, true);
  assert.equal(detection.installPath, installPath);

  const scan = await manager.scan({ installPath, baseUrl, force: true });
  assert.equal(scan.ok, true);
  assert.equal(scan.files.find((file) => file.filePath === "/data/current.bin").state, "current");
  assert.equal(scan.files.find((file) => file.filePath === "/data/outdated.bin").state, "outdated");
  assert.equal(scan.files.find((file) => file.filePath === "/nested/missing.bin").state, "missing");
  const linkedTarget = await manager.inspect(installPath, {
    ...files[0],
    filePath: "/data/linked/outside.bin",
  });
  assert.equal(linkedTarget.state, "error");

  const update = await manager.update({
    installPath,
    baseUrl,
    baseUrls: [`${baseUrl}/unavailable`, baseUrl],
    paths: ["/data/outdated.bin", "/nested/missing.bin"],
  });
  assert.equal(update.ok, true);
  assert.equal(update.updated, 2);
  assert.equal(Number.isFinite(update.sourceLatencyMs), true);
  assert.equal(update.sourceName, "备用源");
  const sourceEvent = progressEvents.find((event) => event.phase === "source-selected");
  assert.equal(sourceEvent.sourceName, "备用源");
  assert.equal(sourceEvent.sourceLatencyMs, update.sourceLatencyMs);
  assert.equal(progressEvents.indexOf(sourceEvent) < progressEvents.findIndex((event) => event.phase === "downloading"), true);
  assert.equal(await fsp.readFile(path.join(installPath, "data", "outdated.bin"), "utf8"), "updated-data");
  assert.equal(await fsp.readFile(path.join(installPath, "nested", "missing.bin"), "utf8"), "missing-data");
  assert.throws(() => targetPath(installPath, "/data/../../outside"), /非法/);

  const allFiles = [
    ...(await fsp.readdir(path.join(installPath, "data"))),
    ...(await fsp.readdir(path.join(installPath, "nested"))),
  ];
  assert.equal(allFiles.some((name) => name.includes(".tmpup-")), false);
  assert.equal(progressEvents.some((event) => event.phase === "verifying"), true);
  assert.equal(progressEvents.some((event) => event.phase === "retrying"), true);
  assert.equal(requests.get("/nested/missing.bin"), 2);

  const backups = await manager.listBackups(installPath);
  assert.equal(backups.length, 1);
  assert.equal(backups[0].filePath, "/data/outdated.bin");
  const restored = await manager.restoreBackup(installPath, backups[0].id);
  assert.equal(restored.ok, true);
  assert.equal(await fsp.readFile(path.join(installPath, "data", "outdated.bin"), "utf8"), "outdated-old");
  const repaired = await manager.update({ installPath, baseUrl, paths: ["/data/current.bin"], forceRepair: true });
  assert.equal(repaired.updated, 1);

  await fsp.writeFile(path.join(installPath, "data", "outdated.bin"), "outdated-old");
  permanentFailure = true;
  const failed = await manager.update({ installPath, baseUrl, paths: ["/data/outdated.bin"] });
  assert.equal(failed.failed, 1);
  assert.equal(requests.get("/data/outdated.bin"), 4);
  assert.equal(await fsp.readFile(path.join(installPath, "data", "outdated.bin"), "utf8"), "outdated-old");
  assert.equal((await fsp.readdir(path.join(installPath, "data"))).some((name) => name.includes(".tmpup-")), false);

  console.log(
    JSON.stringify(
      {
        autoDetected: detection.ok,
        states: scan.files.map((file) => file.state),
        updated: update.updated,
        failed: update.failed,
        progressEvents: progressEvents.length,
        transientRetries: requests.get("/nested/missing.bin"),
        permanentFailure: failed.failed,
        backups: backups.length,
        forcedRepair: repaired.updated,
      },
      null,
      2,
    ),
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fsp.rm(root, { recursive: true, force: true });
}
