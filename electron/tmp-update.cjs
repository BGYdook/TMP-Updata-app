const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const MANIFEST_TTL = 60_000;
const MAX_FILE_BYTES = 400 * 1024 * 1024;
const FILE_WORKERS = 4;
const DOWNLOAD_ATTEMPTS = 3;
const RETRY_DELAYS = [1000, 2500];

function retryable(error) {
  if (error?.retryable === false) return false;
  if (["EACCES", "EPERM", "ENOSPC", "EROFS"].includes(error?.code)) return false;
  return true;
}

function waitForRetry(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(new DOMException("更新已取消", "AbortError")); };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeBaseUrl(value) {
  return String(value || "https://tmplistoss.bgydook.cn").trim().replace(/\/+$/, "");
}

function normalizeManifest(payload) {
  if (!payload || payload.code !== 200 || !Array.isArray(payload.data)) {
    throw new Error(payload?.msg || "接口返回了无效的文件清单");
  }
  const normalized = payload.data
    .filter(
      (file) =>
        file &&
        Number.isFinite(Number(file.fileSize)) &&
        /^[a-f0-9]{32}$/i.test(String(file.md5 || "")) &&
        typeof file.filePath === "string" &&
        file.filePath.startsWith("/"),
    )
    .map((file) => ({
      type: Number(file.type) || 0,
      typeName: String(file.typeName || "其他"),
      md5: String(file.md5).toLowerCase(),
      fileSize: Number(file.fileSize),
      filePath: String(file.filePath).replaceAll("\\", "/"),
      downloadUrl: String(file.downloadUrl || ""),
      updateTime: String(file.updateTime || ""),
    }));
  const unique = new Map(normalized.map((file) => [file.filePath, file]));
  return [...unique.values()]
    .slice(0, 5000)
    .sort((a, b) => a.filePath.localeCompare(b.filePath));
}

function fileSegments(filePath) {
  const normalized = String(filePath || "").replaceAll("\\", "/");
  if (!normalized.startsWith("/") || normalized.includes("\0")) {
    throw new Error("TMP 文件路径无效");
  }
  const segments = normalized.split("/").filter(Boolean);
  if (
    !segments.length ||
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        /^[a-zA-Z]:$/.test(segment) ||
        /[<>:"|?*]/.test(segment),
    )
  ) {
    throw new Error(`TMP 文件路径包含非法片段：${filePath}`);
  }
  return segments;
}

function targetPath(installPath, filePath) {
  const root = path.resolve(installPath);
  const target = path.resolve(root, ...fileSegments(filePath));
  if (!target.startsWith(root + path.sep)) throw new Error("TMP 文件路径越界");
  return target;
}

function resolveDownloadUrl(baseUrl, file) {
  const base = new URL(`${normalizeBaseUrl(baseUrl)}/`);
  const url = new URL(file.downloadUrl || `/files${file.filePath}?v=${file.md5}`, base);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((!local && url.protocol !== "https:") || (url.origin !== base.origin && !local)) {
    throw new Error("TMP 文件下载地址不在当前服务允许的域名内");
  }
  if (!url.searchParams.get("v")) url.searchParams.set("v", file.md5);
  return url.toString();
}

async function hashFile(filePath) {
  const hash = crypto.createHash("md5");
  const handle = await fsp.open(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function ensureGamesClosed() {
  if (process.platform !== "win32") return;
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync(
      "tasklist.exe",
      ["/FO", "CSV", "/NH"],
      { timeout: 8000, windowsHide: true },
    ));
  } catch {
    return;
  }
  if (/"(?:TruckersMP(?:-Launcher)?|eurotrucks2|amtrucks)\.exe"/i.test(stdout)) {
    throw new Error("请先关闭 TruckersMP 启动器、欧卡 2 和美卡后再更新");
  }
}

class TmpUpdateManager {
  constructor({ configPaths, onProgress, fetcher }) {
    this.configPaths = configPaths;
    this.onProgress = onProgress;
    this.fetcher = fetcher || globalThis.fetch;
    this.manifest = null;
    this.hashCache = new Map();
    this.updateController = null;
    this.updating = false;
  }

  async detectInstallPath() {
    const checked = [];
    for (const configPath of this.configPaths) {
      checked.push(configPath);
      let parsed;
      try {
        parsed = JSON.parse(await fsp.readFile(configPath, "utf8"));
      } catch {
        continue;
      }
      if (typeof parsed.installPath !== "string" || !path.isAbsolute(parsed.installPath)) {
        continue;
      }
      try {
        const installPath = await fsp.realpath(parsed.installPath);
        const stat = await fsp.stat(installPath);
        const dataStat = await fsp.stat(path.join(installPath, "data"));
        if (!stat.isDirectory() || !dataStat.isDirectory()) continue;
        return {
          ok: true,
          installPath,
          launcherConfig: configPath,
          message: "已自动检测到 TruckersMP 客户端",
        };
      } catch {
        // Continue to the next known launcher configuration.
      }
    }
    return {
      ok: false,
      installPath: "",
      launcherConfig: "",
      checked,
      message: "未找到 TruckersMP 安装目录，请先启动一次启动器或手动选择目录",
    };
  }

  async validateInstallPath(installPath) {
    if (!installPath || !path.isAbsolute(installPath)) {
      throw new Error("TruckersMP 安装目录无效");
    }
    const resolved = await fsp.realpath(installPath);
    const stat = await fsp.stat(resolved);
    if (!stat.isDirectory()) throw new Error("TruckersMP 安装目录不是文件夹");
    const data = await fsp.stat(path.join(resolved, "data"));
    if (!data.isDirectory()) throw new Error("所选目录不包含 TruckersMP data 文件夹");
    return resolved;
  }

  async fetchManifest(baseUrl, force = false) {
    if (!force && this.manifest && Date.now() - this.manifest.at < MANIFEST_TTL) {
      return this.manifest.files;
    }
    const base = normalizeBaseUrl(baseUrl);
    const response = await this.fetcher(`${base}/api/tmp/files`, {
      headers: { Accept: "application/json", "User-Agent": "TMP-Sync-Desktop" },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`文件清单请求失败（HTTP ${response.status}）`);
    const requested = new URL(`${base}/api/tmp/files`);
    const finalUrl = new URL(response.url || requested);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(requested.hostname);
    if (!local && finalUrl.origin !== requested.origin) {
      throw new Error("文件清单请求被重定向到非受信任地址");
    }
    const files = normalizeManifest(await response.json());
    if (!files.length) throw new Error("TMP 文件清单为空");
    this.manifest = { at: Date.now(), files };
    return files;
  }

  async inspect(installPath, file) {
    const target = targetPath(installPath, file.filePath);
    let stat;
    try {
      stat = await fsp.lstat(target);
    } catch (error) {
      if (error && error.code === "ENOENT") return { ...file, state: "missing" };
      return { ...file, state: "error", error: messageOf(error) };
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { ...file, state: "error", localSize: stat.size, error: "目标不是普通文件" };
    }
    if (stat.size !== file.fileSize) {
      return { ...file, state: "outdated", localSize: stat.size };
    }
    const cached = this.hashCache.get(target);
    let md5 =
      cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size
        ? cached.md5
        : "";
    try {
      if (!md5) {
        md5 = await hashFile(target);
        this.hashCache.set(target, { mtimeMs: stat.mtimeMs, size: stat.size, md5 });
      }
    } catch (error) {
      return {
        ...file,
        state: "error",
        localSize: stat.size,
        error: `无法读取本地文件：${messageOf(error)}`,
      };
    }
    return {
      ...file,
      state: md5 === file.md5 ? "current" : "outdated",
      localSize: stat.size,
      localMd5: md5,
    };
  }

  async scan({ installPath, baseUrl, force = false }) {
    const resolved = await this.validateInstallPath(installPath);
    const files = await this.fetchManifest(baseUrl, force);
    const result = new Array(files.length);
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= files.length) return;
        result[index] = await this.inspect(resolved, files[index]);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(FILE_WORKERS, files.length) }, worker),
    );
    return {
      ok: true,
      installPath: resolved,
      files: result,
      scannedAt: new Date().toISOString(),
    };
  }

  emit(progress) {
    this.onProgress?.(progress);
  }

  async install(installPath, baseUrl, file, report) {
    const target = targetPath(installPath, file.filePath);
    const parent = path.dirname(target);
    await fsp.mkdir(parent, { recursive: true });
    const token = crypto.randomUUID();
    const temporary = path.join(parent, `.${path.basename(target)}.tmpup-${token}.part`);
    const backup = path.join(parent, `.${path.basename(target)}.tmpup-${token}.bak`);
    const requestedUrl = resolveDownloadUrl(baseUrl, file);
    let actual;
    for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
      let handle;
      try {
        report(0, file.fileSize, "downloading", `下载 ${file.filePath}（${attempt}/${DOWNLOAD_ATTEMPTS}）`);
        const response = await this.fetcher(requestedUrl, {
          headers: { Accept: "application/octet-stream", "User-Agent": "TMP-Sync-Desktop" },
          cache: "no-cache",
          signal: AbortSignal.any([this.updateController.signal, AbortSignal.timeout(900_000)]),
        });
        if (!response.ok || !response.body) {
          const error = new Error(response.status === 404 ? "远端文件不存在，请刷新文件清单"
            : response.status === 429 ? "请求过于频繁，请稍后重试"
              : response.status === 403 ? "当前 IP 受到下载限制"
                : `下载失败（HTTP ${response.status}）`);
          error.retryable = response.status === 429 || response.status >= 500;
          throw error;
        }
        const requested = new URL(requestedUrl);
        const finalUrl = new URL(response.url || requested);
        const local = ["localhost", "127.0.0.1", "[::1]"].includes(requested.hostname);
        if (!local && finalUrl.origin !== requested.origin) {
          const error = new Error("文件下载被重定向到非受信任地址");
          error.retryable = false;
          throw error;
        }
        const contentLength = Number(response.headers.get("content-length")) || file.fileSize;
        if (contentLength > MAX_FILE_BYTES) {
          const error = new Error("文件超过 400 MB 安全上限");
          error.retryable = false;
          throw error;
        }
        const hasher = crypto.createHash("md5");
        handle = await fsp.open(temporary, "wx");
        let downloaded = 0;
        let lastEmit = 0;
        for await (const chunk of response.body) {
          if (this.updateController.signal.aborted) throw new DOMException("更新已取消", "AbortError");
          const bytes = Buffer.from(chunk);
          if (downloaded + bytes.length > MAX_FILE_BYTES) {
            const error = new Error("文件超过 400 MB 安全上限");
            error.retryable = false;
            throw error;
          }
          await handle.write(bytes);
          hasher.update(bytes);
          downloaded += bytes.length;
          const now = Date.now();
          if (now - lastEmit >= 100) {
            report(downloaded, file.fileSize, "downloading", `下载 ${file.filePath}（${attempt}/${DOWNLOAD_ATTEMPTS}）`);
            lastEmit = now;
          }
        }
        await handle.close();
        handle = null;
        if (downloaded !== file.fileSize) throw new Error(`文件长度不一致：期望 ${file.fileSize} 字节，实际 ${downloaded} 字节`);
        report(downloaded, file.fileSize, "verifying", `正在校验 ${file.filePath}`);
        actual = hasher.digest("hex");
        if (actual !== file.md5) throw new Error("MD5 校验失败，文件可能不完整");
        break;
      } catch (error) {
        await handle?.close().catch(() => undefined);
        await fsp.rm(temporary, { force: true }).catch(() => undefined);
        if (this.updateController.signal.aborted) throw new DOMException("更新已取消", "AbortError");
        if (attempt === DOWNLOAD_ATTEMPTS || !retryable(error)) throw error;
        report(0, file.fileSize, "retrying", `${messageOf(error)}，${RETRY_DELAYS[attempt - 1] / 1000} 秒后重试（${attempt + 1}/${DOWNLOAD_ATTEMPTS}）`);
        await waitForRetry(RETRY_DELAYS[attempt - 1], this.updateController.signal);
      }
    }

    report(file.fileSize, file.fileSize, "installing", `正在安装 ${file.filePath}`);
    let movedOld = false;
    try {
      try {
        await fsp.rename(target, backup);
        movedOld = true;
      } catch (error) {
        if (!error || error.code !== "ENOENT") throw error;
      }
      await fsp.rename(temporary, target);
      if (movedOld) await fsp.rm(backup, { force: true });
      const installed = await fsp.stat(target);
      this.hashCache.set(target, {
        mtimeMs: installed.mtimeMs,
        size: installed.size,
        md5: actual,
      });
    } catch (error) {
      if (movedOld && !fs.existsSync(target) && fs.existsSync(backup)) {
        await fsp.rename(backup, target).catch(() => undefined);
      }
      throw error;
    } finally {
      await fsp.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async update({ installPath, baseUrl, paths }) {
    if (this.updating) throw new Error("TMP 更新正在进行中");
    this.updating = true;
    this.updateController = new AbortController();
    try {
      await ensureGamesClosed();
      const resolved = await this.validateInstallPath(installPath);
      const files = await this.fetchManifest(baseUrl, true);
      const selected = new Set(Array.isArray(paths) ? paths : []);
      if (!selected.size) throw new Error("没有选择需要更新的文件");
      const candidates = files.filter((file) => selected.has(file.filePath));
      const inspected = await Promise.all(
        candidates.map((file) => this.inspect(resolved, file)),
      );
      const targets = inspected.filter(
        (file) => file.state === "outdated" || file.state === "missing",
      );
      if (!targets.length) {
        return { ok: true, updated: 0, failed: 0, errors: [], message: "没有需要更新的文件" };
      }

      const totalBytes = targets.reduce((sum, file) => sum + file.fileSize, 0);
      const downloadedByFile = new Map(targets.map((file) => [file.filePath, 0]));
      const errors = [];
      let updated = 0;
      let completed = 0;
      let cursor = 0;
      let transferredBytes = 0;
      const previousBytes = new Map();
      const rateSamples = [];

      const emitProgress = (file, downloaded, completedFiles, phase, message) => {
        const previous = previousBytes.get(file.filePath) || 0;
        transferredBytes += downloaded < previous ? downloaded : downloaded - previous;
        previousBytes.set(file.filePath, downloaded);
        downloadedByFile.set(file.filePath, Math.min(downloaded, file.fileSize));
        const now = Date.now();
        rateSamples.push([now, transferredBytes]);
        while (rateSamples.length > 1 && rateSamples[0][0] < now - 3000) rateSamples.shift();
        const elapsed = now - rateSamples[0][0];
        const speed = elapsed >= 300 ? Math.max(0, Math.round(
          ((transferredBytes - rateSamples[0][1]) * 1000) / elapsed,
        )) : 0;
        const overallDownloaded = Math.min(
          totalBytes,
          [...downloadedByFile.values()].reduce((sum, value) => sum + value, 0),
        );
        this.emit({
          filePath: file.filePath,
          completed: completedFiles,
          totalFiles: targets.length,
          downloaded,
          totalBytes: file.fileSize,
          overallDownloaded,
          overallTotalBytes: totalBytes,
          overallPercent:
            totalBytes > 0 ? Math.round((overallDownloaded / totalBytes) * 100) : 0,
          speed,
          etaSeconds: speed > 0 ? Math.ceil((totalBytes - overallDownloaded) / speed) : null,
          phase,
          message,
        });
      };

      const worker = async () => {
        while (true) {
          if (this.updateController.signal.aborted) return;
          const index = cursor++;
          if (index >= targets.length) return;
          const file = targets[index];
          emitProgress(file, 0, completed, "downloading", `正在更新 ${file.filePath}`);
          try {
            await this.install(resolved, baseUrl, file, (downloaded, _total, phase, message) => {
              emitProgress(file, downloaded, completed, phase, message);
            });
            downloadedByFile.set(file.filePath, file.fileSize);
            updated += 1;
            emitProgress(file, file.fileSize, completed + 1, "done", `已更新 ${file.filePath}`);
          } catch (error) {
            downloadedByFile.set(file.filePath, 0);
            if (!(error && error.name === "AbortError")) {
              errors.push({ filePath: file.filePath, message: messageOf(error) });
            }
          } finally {
            completed += 1;
          }
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(FILE_WORKERS, targets.length) }, worker),
      );
      const cancelled = this.updateController.signal.aborted;
      const failed = errors.length;
      this.emit({
        filePath: "",
        completed,
        totalFiles: targets.length,
        downloaded: 0,
        totalBytes: 0,
        overallDownloaded: Math.min(
          totalBytes,
          [...downloadedByFile.values()].reduce((sum, value) => sum + value, 0),
        ),
        overallTotalBytes: totalBytes,
        overallPercent: cancelled ? 0 : failed ? Math.round((updated / targets.length) * 100) : 100,
        speed: 0,
        etaSeconds: null,
        phase: "done",
        message: cancelled ? "更新已取消" : failed ? `${failed} 个文件更新失败` : "更新完成",
      });
      return {
        ok: !cancelled && failed === 0,
        cancelled,
        updated,
        failed,
        errors,
        message: cancelled
          ? `更新已取消，已完成 ${updated} 个文件`
          : failed
            ? `已更新 ${updated} 个文件，${failed} 个失败`
            : `已成功更新 ${updated} 个文件`,
      };
    } finally {
      this.updating = false;
      this.updateController = null;
    }
  }

  cancel() {
    this.updateController?.abort();
    return { ok: true };
  }
}

module.exports = {
  TmpUpdateManager,
  fileSegments,
  normalizeManifest,
  resolveDownloadUrl,
  targetPath,
};
