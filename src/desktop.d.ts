import type { SyncItem } from "./types";

declare global {
  interface DesktopDetectionResult {
    ok: boolean;
    installPath: string;
    launcherConfig: string;
    checked?: string[];
    cancelled?: boolean;
    message: string;
  }

  interface DesktopScanResult {
    ok: boolean;
    message?: string;
    installPath?: string;
    files: SyncItem[];
    scannedAt?: string;
  }

  interface DesktopUpdateProgress {
    filePath: string;
    completed: number;
    totalFiles: number;
    downloaded: number;
    totalBytes: number;
    overallDownloaded: number;
    overallTotalBytes: number;
    overallPercent: number;
    speed: number;
    etaSeconds: number | null;
    phase: "downloading" | "retrying" | "verifying" | "installing" | "done";
    message: string;
  }

  interface DesktopUpdateResult {
    ok: boolean;
    cancelled?: boolean;
    updated: number;
    failed: number;
    errors: Array<{ filePath: string; message: string }>;
    message: string;
    sourceLatencyMs?: number;
  }

  interface DesktopAppUpdateResult {
    ok: boolean;
    available: boolean;
    currentVersion: string;
    latestVersion: string;
    releaseUrl: string;
    message: string;
  }

  interface DesktopAppUpdateProgress {
    downloaded: number;
    total: number;
    percent: number;
    speed: number;
    etaSeconds: number | null;
    phase: string;
    message: string;
    stalled: boolean;
  }

  interface DesktopBackup {
    id: string;
    filePath: string;
    md5: string;
    size: number;
    createdAt: string;
  }

  interface DesktopNetworkDiagnostic {
    ok: boolean;
    latencyMs?: number;
    status?: number;
    files?: number;
    message: string;
  }

  interface TmpDesktopApi {
    isDesktop: true;
    detectInstallPath(): Promise<DesktopDetectionResult>;
    chooseInstallPath(): Promise<DesktopDetectionResult>;
    scan(options: {
      installPath: string;
      baseUrl: string;
      force?: boolean;
    }): Promise<DesktopScanResult>;
    update(options: {
      installPath: string;
      baseUrl: string;
      baseUrls?: string[];
      paths: string[];
      forceRepair?: boolean;
    }): Promise<DesktopUpdateResult>;
    cancelUpdate(): Promise<{ ok: boolean }>;
    pauseUpdate(): Promise<{ ok: boolean; paused: boolean }>;
    resumeUpdate(): Promise<{ ok: boolean; paused: boolean }>;
    listBackups(installPath: string): Promise<{ ok: boolean; backups: DesktopBackup[] }>;
    restoreBackup(options: { installPath: string; id: string }): Promise<{ ok: boolean; filePath?: string; message: string }>;
    cleanupBackups(installPath: string): Promise<{ ok: boolean; removed?: number; remaining?: number; message?: string }>;
    diagnoseNetwork(): Promise<DesktopNetworkDiagnostic>;
    getBackgroundMode(): Promise<{ backgroundMode: boolean }>;
    setBackgroundMode(enabled: boolean): Promise<{ backgroundMode: boolean }>;
    exportDiagnostics(snapshot: {
      sourceState: string;
      lastScannedAt: string;
      files: Array<{ path: string; state: string; error: string }>;
      activities: Array<{ time: string; level: string; message: string }>;
    }): Promise<{ ok: boolean; cancelled?: boolean }>;
    reportCheckError(reason: string): Promise<void>;
    checkAppUpdate(): Promise<DesktopAppUpdateResult>;
    installAppUpdate(): Promise<{ ok: boolean; message: string }>;
    onAppUpdateProgress(callback: (progress: DesktopAppUpdateProgress) => void): () => void;
    openExternal(url: string): Promise<{ ok: boolean }>;
    onProgress(callback: (progress: DesktopUpdateProgress) => void): () => void;
  }

  interface Window {
    tmpDesktop?: TmpDesktopApi;
  }
}

export {};
