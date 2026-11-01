const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  net,
  protocol,
  session,
  shell,
  Tray,
  Menu,
  Notification,
  nativeImage,
} = require("electron");
const path = require("node:path");
const fsp = require("node:fs/promises");
const { TmpUpdateManager } = require(
  app.isPackaged ? "./tmp-update.release.cjs" : "./tmp-update.cjs",
);

const DEV_URL = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173";
const TMP_API_BASE = "https://tmplistoss.bgydook.cn";
const CNB_REPO_SLUG = "BGYdook/TMP-Updata-app";
const CNB_RELEASES_URL = `https://cnb.cool/${CNB_REPO_SLUG}/-/releases/latest`;
const CNB_RELEASE_ORIGIN = "https://cnb.cool";
const CNB_CDN_ORIGIN = "https://cnb.cdn-go.cn";
const CNB_ASSET_ORIGIN = "https://asset.cnb.cool";
const APP_ORIGIN = "tmp-app://bundle";
protocol.registerSchemesAsPrivileged([
  {
    scheme: "tmp-app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let mainWindow = null;
let tray = null;
let quitting = false;
let backgroundMode = true;
let lastPendingSignature = "";
let lastCheckError = "";
let pendingAppUpdate = null;
let activeInstallPath = "";
const trustedInstallPaths = new Set();

function broadcastProgress(progress) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("tmp:update-progress", progress);
  }
}

let tmpUpdate = null;

function notify(title, body) {
  if (!Notification.isSupported()) return;
  const message = new Notification({ title, body, silent: false });
  message.on("click", showWindow);
  message.show();
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) { void createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function setupTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, "..", app.isPackaged ? "dist" : "public", "app-icon.png"));
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip("TMP 更新工具");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 TMP 更新工具", click: showWindow },
    { type: "separator" },
    { label: "退出", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("double-click", showWindow);
  tray.on("click", showWindow);
}

function parseAppVersion(value) {
  const match = String(value || "").trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareAppVersions(left, right) {
  const a = parseAppVersion(left) || [0, 0, 0];
  const b = parseAppVersion(right) || [0, 0, 0];
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

async function getLatestCnbRelease() {
  const response = await net.fetch(CNB_RELEASES_URL, {
    headers: { Accept: "text/html", "User-Agent": "TMP-File-Mirror-Desktop" },
    cache: "no-cache",
  });
  if (!response.ok) throw new Error(`获取 CNB 更新信息失败（HTTP ${response.status}）`);
  const html = await response.text();
  const tags = [
    ...[...html.matchAll(/\/-\/releases\/tag\/(v\d+\.\d+\.\d+(?:[-.][A-Za-z0-9]+)*)/g)].map((match) => match[1]),
    ...[...html.matchAll(/\\?"tag\\?",\\?"(v\d+\.\d+\.\d+(?:[-.][A-Za-z0-9]+)*)/g)].map((match) => match[1]),
  ]
    .filter((tag, index, values) => values.indexOf(tag) === index)
    .sort((left, right) => compareAppVersions(right, left));
  const tag = tags[0];
  if (!tag) throw new Error("CNB 暂无可用的版本发布");
  const version = tag.slice(1);
  const assetName = `TMP-Update-${version}-Setup.exe`;
  return {
    version,
    tag,
    assetName,
    releaseUrl: `https://cnb.cool/${CNB_REPO_SLUG}/-/releases/tag/${tag}`,
    downloadUrl: `https://cnb.cool/${CNB_REPO_SLUG}/-/releases/download/${tag}/${assetName}`,
  };
}

function getTmpUpdate() {
  if (!tmpUpdate) throw new Error("TMP 更新服务尚未初始化");
  return tmpUpdate;
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function trustInstallPath(installPath) {
  if (!installPath || !path.isAbsolute(installPath)) {
    throw new Error("安装目录无效");
  }
  const resolved = path.resolve(installPath);
  trustedInstallPaths.add(pathKey(resolved));
  activeInstallPath = resolved;
  return resolved;
}

function requireTrustedInstallPath(installPath) {
  if (
    typeof installPath !== "string" ||
    !trustedInstallPaths.has(pathKey(installPath))
  ) {
    throw new Error("安装目录未经本应用检测或选择");
  }
  activeInstallPath = path.resolve(installPath);
  return activeInstallPath;
}

function assertTrustedSender(event) {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender !== mainWindow.webContents ||
    !event.senderFrame ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error("拒绝未受信任的 IPC 调用");
  }
  const currentUrl = event.senderFrame.url || "";
  const trusted = app.isPackaged
    ? currentUrl.startsWith(`${APP_ORIGIN}/index.html`)
    : currentUrl.startsWith(DEV_URL);
  if (!trusted) throw new Error("拒绝非应用页面发起的 IPC 调用");
}

function hardenWebContents(contents) {
  contents.on("will-navigate", (event, targetUrl) => {
    const allowed = app.isPackaged
      ? targetUrl.startsWith(`${APP_ORIGIN}/`)
      : targetUrl.startsWith(DEV_URL);
    if (!allowed) event.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-attach-webview", (event) => event.preventDefault());
  if (app.isPackaged) {
    contents.on("devtools-opened", () => contents.closeDevTools());
  }
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 920,
    minWidth: 860,
    minHeight: 640,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0e1217" : "#f3f1ec",
    title: "TMP 更新工具",
    icon: path.join(
      __dirname,
      "..",
      app.isPackaged ? "dist" : "public",
      "app-icon.png",
    ),
    autoHideMenuBar: true,
    safeDialogs: true,
    webPreferences: {
      backgroundThrottling: false,
      preload: path.join(
        __dirname,
        app.isPackaged ? "preload.release.cjs" : "preload.cjs",
      ),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.removeMenu();
  mainWindow.on("close", (event) => {
    if (!quitting && backgroundMode && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame) return;
      const message = `${new Date().toISOString()} ${errorCode} ${errorDescription} ${validatedUrl}\n`;
      void fsp
        .appendFile(
          path.join(app.getPath("userData"), "load-error.log"),
          message,
        )
        .catch(() => undefined);
      if (!mainWindow.isVisible()) mainWindow.show();
    },
  );
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const docsUrl = `${TMP_API_BASE}/docs/`;
    if (url === docsUrl) void shell.openExternal(docsUrl);
    return { action: "deny" };
  });
  if (app.isPackaged) {
    mainWindow.webContents.on("before-input-event", (event, input) => {
      const key = String(input.key || "").toLowerCase();
      const blocked =
        key === "f12" ||
        (input.control && input.shift && ["i", "j", "c"].includes(key)) ||
        (input.control && key === "u");
      if (blocked) event.preventDefault();
    });
  }

  if (!app.isPackaged) {
    await mainWindow.loadURL(DEV_URL);
  } else {
    await mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
  }
}

async function registerAppProtocol() {
  const distRoot = path.resolve(__dirname, "..", "dist");
  const contentTypes = new Map([
    [".html", "text/html; charset=utf-8"],
    [".js", "text/javascript; charset=utf-8"],
    [".css", "text/css; charset=utf-8"],
    [".svg", "image/svg+xml"],
    [".png", "image/png"],
    [".woff2", "font/woff2"],
  ]);
  protocol.handle("tmp-app", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== "bundle")
        return new Response("Not found", { status: 404 });
      const relative =
        decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
      const target = path.resolve(distRoot, relative);
      if (!target.startsWith(distRoot + path.sep)) {
        return new Response("Forbidden", { status: 403 });
      }
      const data = await fsp.readFile(target);
      const type =
        contentTypes.get(path.extname(target).toLowerCase()) ||
        "application/octet-stream";
      return new Response(data, {
        status: 200,
        headers: {
          "Content-Type": type,
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

ipcMain.handle("tmp:detect-install", async (event) => {
  assertTrustedSender(event);
  const result = await getTmpUpdate().detectInstallPath();
  if (result.ok && result.installPath) trustInstallPath(result.installPath);
  return result;
});

ipcMain.handle("tmp:choose-install", async (event) => {
  assertTrustedSender(event);
  if (!mainWindow) return { ok: false, message: "窗口尚未就绪" };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择 TruckersMP 的 installation 文件夹",
    properties: ["openDirectory"],
    buttonLabel: "选择此目录",
  });
  if (result.canceled || !result.filePaths[0]) {
    return { ok: false, cancelled: true, message: "未选择目录" };
  }
  try {
    const installPath = await getTmpUpdate().validateInstallPath(
      result.filePaths[0],
    );
    trustInstallPath(installPath);
    return {
      ok: true,
      installPath,
      launcherConfig: "",
      message: "已选择 TruckersMP 安装目录",
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle("tmp:scan", async (event, options) => {
  try {
    assertTrustedSender(event);
    if (!options || typeof options !== "object")
      throw new Error("扫描参数无效");
    const installPath = requireTrustedInstallPath(options.installPath);
    const result = await getTmpUpdate().scan({
      installPath,
      baseUrl: TMP_API_BASE,
      force: true,
    });
    if (result.ok) {
      lastCheckError = "";
      const pending = result.files.filter((file) => file.state === "missing" || file.state === "outdated");
      const signature = pending.map((file) => `${file.filePath}:${file.md5}`).sort().join("|");
      if (signature && signature !== lastPendingSignature && mainWindow && !mainWindow.isVisible()) {
        notify("发现 TMP 更新", `${pending.length} 个文件需要更新，点击查看。`);
      }
      lastPendingSignature = signature;
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (mainWindow && !mainWindow.isVisible() && message !== lastCheckError) {
      notify("TMP 检测失败", message.slice(0, 160));
      lastCheckError = message;
    }
    return {
      ok: false,
      message,
      files: [],
    };
  }
});

ipcMain.handle("tmp:report-check-error", (event, reason) => {
  assertTrustedSender(event);
  const message = String(reason || "连接更新服务失败").slice(0, 160);
  if (mainWindow && !mainWindow.isVisible() && message !== lastCheckError) {
    notify("TMP 检测失败", message);
  }
  lastCheckError = message;
});

ipcMain.handle("tmp:update", async (event, options) => {
  try {
    assertTrustedSender(event);
    if (
      !options ||
      typeof options !== "object" ||
      !Array.isArray(options.paths)
    ) {
      throw new Error("更新参数无效");
    }
    if (
      options.paths.length === 0 ||
      options.paths.length > 500 ||
      options.paths.some((item) => typeof item !== "string")
    ) {
      throw new Error("更新文件选择无效");
    }
    const installPath = requireTrustedInstallPath(options.installPath);
    const result = await getTmpUpdate().update({
      installPath,
      baseUrl: TMP_API_BASE,
      paths: [...new Set(options.paths)],
    });
    if (mainWindow && !mainWindow.isVisible()) {
      notify(result.failed ? "TMP 更新需要处理" : result.cancelled ? "TMP 更新已取消" : "TMP 更新完成", result.message);
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (mainWindow && !mainWindow.isVisible()) notify("TMP 更新失败", message.slice(0, 160));
    return {
      ok: false,
      updated: 0,
      failed: 0,
      errors: [],
      message,
    };
  }
});

ipcMain.handle("tmp:cancel-update", (event) => {
  assertTrustedSender(event);
  return getTmpUpdate().cancel();
});

ipcMain.handle("tmp:set-background", async (event, enabled) => {
  assertTrustedSender(event);
  backgroundMode = enabled === true;
  await fsp.writeFile(path.join(app.getPath("userData"), "preferences.json"), JSON.stringify({ backgroundMode }));
  return { backgroundMode };
});

ipcMain.handle("tmp:get-background", (event) => {
  assertTrustedSender(event);
  return { backgroundMode };
});

ipcMain.handle("tmp:export-diagnostics", async (event, snapshot) => {
  assertTrustedSender(event);
  const data = snapshot && typeof snapshot === "object" ? snapshot : {};
  const files = Array.isArray(data.files) ? data.files.slice(0, 5000).map((file) => ({
    path: String(file.path || "").slice(0, 500),
    state: String(file.state || "").slice(0, 40),
    error: String(file.error || "").slice(0, 1000),
  })) : [];
  const activities = Array.isArray(data.activities) ? data.activities.slice(0, 100).map((entry) => ({
    time: String(entry.time || "").slice(0, 50),
    level: String(entry.level || "").slice(0, 20),
    message: String(entry.message || "").slice(0, 1000),
  })) : [];
  const output = { exportedAt: new Date().toISOString(), appVersion: app.getVersion(), platform: process.platform,
    installPath: activeInstallPath, sourceState: String(data.sourceState || "").slice(0, 30),
    lastScannedAt: String(data.lastScannedAt || "").slice(0, 60), files, activities };
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "导出 TMP 诊断日志",
    defaultPath: `TMP-Diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
  await fsp.writeFile(result.filePath, JSON.stringify(output, null, 2), "utf8");
  return { ok: true };
});

ipcMain.handle("tmp:check-app-update", async (event) => {
  assertTrustedSender(event);
  try {
    const latest = await getLatestCnbRelease();
    const currentVersion = app.getVersion();
    const available = compareAppVersions(latest.version, currentVersion) > 0;
    pendingAppUpdate = available ? latest : null;
    return {
      ok: true,
      available,
      currentVersion,
      latestVersion: latest.version,
      releaseUrl: latest.releaseUrl,
      message: available ? `发现新版本 v${latest.version}` : "当前已是最新版本",
    };
  } catch (error) {
    pendingAppUpdate = null;
    return {
      ok: false,
      available: false,
      currentVersion: app.getVersion(),
      latestVersion: "",
      releaseUrl: `https://cnb.cool/${CNB_REPO_SLUG}/-/releases/latest`,
      message: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle("tmp:install-app-update", async (event) => {
  assertTrustedSender(event);
  if (getTmpUpdate().updating) {
    return { ok: false, message: "请先完成当前文件更新" };
  }
  try {
    const latest = pendingAppUpdate || await getLatestCnbRelease();
    if (compareAppVersions(latest.version, app.getVersion()) <= 0) {
      return { ok: false, message: "当前已是最新版本" };
    }
    if (!event.sender.isDestroyed()) {
      event.sender.send("tmp:app-update-progress", {
        downloaded: 0,
        total: 0,
        percent: 0,
        speed: 0,
        etaSeconds: null,
        phase: "connecting",
        message: "正在连接 CNB 下载服务器…",
        stalled: false,
      });
    }
    const response = await net.fetch(latest.downloadUrl, {
      headers: { Accept: "application/octet-stream", "User-Agent": "TMP-File-Mirror-Desktop" },
      cache: "no-cache",
    });
    if (!response.ok || !response.body) throw new Error(`下载更新安装包失败（HTTP ${response.status}）`);
    const finalUrl = new URL(response.url || latest.downloadUrl);
    if (![CNB_RELEASE_ORIGIN, CNB_CDN_ORIGIN, CNB_ASSET_ORIGIN].includes(finalUrl.origin)) {
      throw new Error("更新安装包被重定向到非受信任地址");
    }
    const contentLength = Number(response.headers.get("content-length")) || 0;
    if (contentLength > 600 * 1024 * 1024) throw new Error("更新安装包超过 600 MB 安全上限");
    const updateDirectory = path.join(app.getPath("userData"), "updates");
    await fsp.mkdir(updateDirectory, { recursive: true });
    const temporary = path.join(updateDirectory, `.${latest.assetName}.part`);
    const installer = path.join(updateDirectory, latest.assetName);
    const handle = await fsp.open(temporary, "w");
    let downloaded = 0;
    const startedAt = Date.now();
    let lastProgressAt = 0;
    let lastChunkAt = Date.now();
    let progressTimer = null;
    const sendProgress = (phase = "downloading", message = "正在下载 CNB 安装包…") => {
      const elapsed = Math.max(1, Date.now() - startedAt) / 1000;
      const speed = downloaded / elapsed;
      const stalled = phase === "downloading" && downloaded < contentLength && Date.now() - lastChunkAt >= 5000;
      if (event.sender.isDestroyed()) return;
      event.sender.send("tmp:app-update-progress", {
        downloaded,
        total: contentLength,
        percent: contentLength > 0 ? Math.min(100, (downloaded / contentLength) * 100) : 0,
        speed,
        etaSeconds: speed > 0 && contentLength > downloaded ? Math.ceil((contentLength - downloaded) / speed) : null,
        phase,
        message: stalled ? "网络暂时没有返回数据，仍在等待…" : message,
        stalled,
      });
    };
    sendProgress();
    progressTimer = setInterval(() => sendProgress(), 1000);
    try {
      for await (const chunk of response.body) {
        const bytes = Buffer.from(chunk);
        downloaded += bytes.length;
        lastChunkAt = Date.now();
        if (downloaded > 600 * 1024 * 1024) throw new Error("更新安装包超过 600 MB 安全上限");
        await handle.write(bytes);
        if (Date.now() - lastProgressAt >= 100 || downloaded === contentLength) {
          lastProgressAt = Date.now();
          sendProgress();
        }
      }
      await handle.close();
      await fsp.rm(installer, { force: true });
      await fsp.rename(temporary, installer);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fsp.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      if (progressTimer) clearInterval(progressTimer);
    }
    sendProgress("done", "安装包下载完成，正在启动安装程序…");
    const launchError = await shell.openPath(installer);
    if (launchError) throw new Error(`无法启动更新安装包：${launchError}`);
    quitting = true;
    setTimeout(() => app.quit(), 250);
    return { ok: true, message: `已下载 v${latest.version} 安装包，正在启动安装程序` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("tmp:open-external", async (event, value) => {
  assertTrustedSender(event);
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error("外部链接无效");
  }
  const pathName = parsed.pathname.replace(/\/+$/, "") || "/";
  const repoPath = "/BGYdook/TMP-Updata-app";
  const allowed = parsed.protocol === "https:" && (
    (parsed.origin === "https://github.com" && (pathName === repoPath || pathName.startsWith(`${repoPath}/releases`))) ||
    (parsed.origin === CNB_RELEASE_ORIGIN && (pathName === repoPath || pathName.startsWith(`${repoPath}/-/releases`))) ||
    (parsed.origin === TMP_API_BASE && (pathName === "/docs" || pathName.startsWith("/docs/")))
  );
  if (!allowed) throw new Error("外部链接不在允许范围内");
  const target = parsed.toString();
  await shell.openExternal(target);
  return { ok: true };
});

if (gotLock) {
  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler(
      (_contents, _permission, callback) => {
        callback(false);
      },
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ["<all_urls>"] },
      (details, callback) => {
        try {
          const target = new URL(details.url);
          const allowed =
            target.protocol === "tmp-app:" ||
            target.origin === TMP_API_BASE ||
            target.origin === CNB_RELEASE_ORIGIN ||
            target.origin === CNB_CDN_ORIGIN ||
            target.origin === CNB_ASSET_ORIGIN ||
            (!app.isPackaged && target.origin === new URL(DEV_URL).origin);
          callback({ cancel: !allowed });
        } catch {
          callback({ cancel: true });
        }
      },
    );
    await registerAppProtocol();
    tmpUpdate = new TmpUpdateManager({
      configPaths: [
        path.join(
          app.getPath("appData"),
          "TruckersMP",
          "launcher-options.json",
        ),
        path.join(
          process.env.LOCALAPPDATA ||
            path.join(app.getPath("appData"), "..", "Local"),
          "TruckersMP",
          "launcher-options.json",
        ),
      ],
      onProgress: broadcastProgress,
      fetcher: (input, init) => net.fetch(input, init),
    });
    try {
      const preferences = JSON.parse(await fsp.readFile(path.join(app.getPath("userData"), "preferences.json"), "utf8"));
      backgroundMode = preferences.backgroundMode !== false;
    } catch { backgroundMode = true; }
    setupTray();
    void createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  });

  app.on("web-contents-created", (_event, contents) => {
    hardenWebContents(contents);
  });

  app.on("second-instance", () => {
    if (!mainWindow) return;
    showWindow();
  });
}

app.on("before-quit", () => { quitting = true; tmpUpdate?.cancel(); });
app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && (!backgroundMode || quitting)) app.quit();
});
