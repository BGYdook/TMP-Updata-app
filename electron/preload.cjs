const { contextBridge, ipcRenderer } = require("electron");

const api = Object.freeze({
  isDesktop: true,
  detectInstallPath: () => ipcRenderer.invoke("tmp:detect-install"),
  chooseInstallPath: () => ipcRenderer.invoke("tmp:choose-install"),
  scan: (options) =>
    ipcRenderer.invoke("tmp:scan", {
      installPath: String(options?.installPath || ""),
    }),
  update: (options) =>
    ipcRenderer.invoke("tmp:update", {
      installPath: String(options?.installPath || ""),
      paths: Array.isArray(options?.paths) ? options.paths.slice(0, 500) : [],
      forceRepair: options?.forceRepair === true,
    }),
  cancelUpdate: () => ipcRenderer.invoke("tmp:cancel-update"),
  pauseUpdate: () => ipcRenderer.invoke("tmp:pause-update"),
  resumeUpdate: () => ipcRenderer.invoke("tmp:resume-update"),
  listBackups: (installPath) => ipcRenderer.invoke("tmp:list-backups", String(installPath || "")),
  restoreBackup: (options) => ipcRenderer.invoke("tmp:restore-backup", {
    installPath: String(options?.installPath || ""),
    id: String(options?.id || ""),
  }),
  cleanupBackups: (installPath) => ipcRenderer.invoke("tmp:cleanup-backups", String(installPath || "")),
  diagnoseNetwork: () => ipcRenderer.invoke("tmp:diagnose-network"),
  getBackgroundMode: () => ipcRenderer.invoke("tmp:get-background"),
  setBackgroundMode: (enabled) => ipcRenderer.invoke("tmp:set-background", enabled === true),
  exportDiagnostics: (snapshot) => ipcRenderer.invoke("tmp:export-diagnostics", snapshot),
  reportCheckError: (reason) => ipcRenderer.invoke("tmp:report-check-error", String(reason || "").slice(0, 160)),
  checkAppUpdate: () => ipcRenderer.invoke("tmp:check-app-update"),
  installAppUpdate: () => ipcRenderer.invoke("tmp:install-app-update"),
  onAppUpdateProgress: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, progress) => callback(Object.freeze({
      downloaded: Number(progress?.downloaded) || 0,
      total: Number(progress?.total) || 0,
      percent: Number(progress?.percent) || 0,
      speed: Number(progress?.speed) || 0,
      etaSeconds: progress?.etaSeconds == null ? null : Number(progress.etaSeconds),
      phase: String(progress?.phase || "downloading"),
      message: String(progress?.message || ""),
      stalled: Boolean(progress?.stalled),
    }));
    ipcRenderer.on("tmp:app-update-progress", listener);
    return () => ipcRenderer.removeListener("tmp:app-update-progress", listener);
  },
  openExternal: (url) => ipcRenderer.invoke("tmp:open-external", String(url || "")),
  onProgress: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, progress) => {
      callback(
        Object.freeze({
          filePath: String(progress?.filePath || ""),
          completed: Number(progress?.completed) || 0,
          totalFiles: Number(progress?.totalFiles) || 0,
          downloaded: Number(progress?.downloaded) || 0,
          totalBytes: Number(progress?.totalBytes) || 0,
          overallDownloaded: Number(progress?.overallDownloaded) || 0,
          overallTotalBytes: Number(progress?.overallTotalBytes) || 0,
          overallPercent: Number(progress?.overallPercent) || 0,
          speed: Number(progress?.speed) || 0,
          etaSeconds: progress?.etaSeconds == null ? null : Number(progress.etaSeconds),
          phase: String(progress?.phase || "downloading"),
          message: String(progress?.message || ""),
          sourceName: progress?.sourceName === "主源" || progress?.sourceName === "备用源" ? progress.sourceName : undefined,
          sourceLatencyMs: Number.isFinite(progress?.sourceLatencyMs) ? progress.sourceLatencyMs : undefined,
        }),
      );
    };
    ipcRenderer.on("tmp:update-progress", listener);
    return () => ipcRenderer.removeListener("tmp:update-progress", listener);
  },
});

contextBridge.exposeInMainWorld("tmpDesktop", api);
