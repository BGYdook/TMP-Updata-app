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
  }

  interface DesktopAppUpdateResult {
    ok: boolean;
    available: boolean;
    currentVersion: string;
    latestVersion: string;
    releaseUrl: string;
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
      paths: string[];
    }): Promise<DesktopUpdateResult>;
    cancelUpdate(): Promise<{ ok: boolean }>;
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
    openExternal(url: string): Promise<{ ok: boolean }>;
    onProgress(callback: (progress: DesktopUpdateProgress) => void): () => void;
  }

  interface Window {
    tmpDesktop?: TmpDesktopApi;
  }
}

export {};
