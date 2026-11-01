import {
  Activity,
  AlertCircle,
  ArrowRight,
  ArrowDownToLine,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  CloudDownload,
  ExternalLink,
  FileDown,
  Download,
  FileClock,
  FolderOpen,
  Gauge,
  Github,
  HardDrive,
  Info,
  Loader2,
  Moon,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  Sun,
  Truck,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildDownloadUrl, DEFAULT_API_BASE, fetchTmpFiles } from "./lib/api";
import { downloadAndInstall } from "./lib/download";
import {
  fileBaseName,
  formatBytes,
  formatClock,
  parentPath,
} from "./lib/format";
import { hashFile } from "./lib/hash";
import { ensurePermission, resolveFileHandle } from "./lib/local-files";
import {
  loadDirectoryHandle,
  loadFingerprints,
  makeFileSignature,
  saveDirectoryHandle,
  saveFingerprints,
  type FileRecord,
} from "./lib/storage";
import type {
  ActivityEntry,
  ScanProgress,
  StatusFilter,
  SyncItem,
  TypeFilter,
  UpdateProgress,
} from "./types";

const AUTO_DETECT_STORAGE_KEY = "tmp-sync-auto-detect";
const THEME_STORAGE_KEY = "tmp-sync-theme";
const UPDATE_CONCURRENCY = 2;
const AUTO_DETECT_INTERVAL = 5 * 60_000;
const APP_VERSION = "1.3.0";
const GITHUB_REPO_URL = "https://github.com/BGYdook/TMP-Updata-app";
const CNB_REPO_URL = "https://cnb.cool/BGYdook/TMP-Updata-app";

interface ConfirmState {
  paths: string[];
  bytes: number;
}

interface AppUpdateState {
  status: "idle" | "checking" | "current" | "available" | "installing" | "error";
  latestVersion?: string;
  releaseUrl?: string;
  message?: string;
}

function isActionable(item: SyncItem): boolean {
  return ["outdated", "missing", "error"].includes(item.state);
}

function isPending(item: SyncItem): boolean {
  return (
    isActionable(item) ||
    ["queued", "downloading", "verifying", "installing"].includes(item.state)
  );
}

function typeAccent(type: number): string {
  if (type === 1) return "system";
  if (type === 2) return "ets2";
  if (type === 3) return "ats";
  return "unknown";
}

function matchesStatus(item: SyncItem, filter: StatusFilter): boolean {
  if (filter === "needs") return isPending(item);
  if (filter === "current")
    return item.state === "current" || item.state === "done";
  if (filter === "error") return item.state === "error";
  return true;
}

function stateOrder(item: SyncItem): number {
  if (item.state === "error") return 0;
  if (["downloading", "verifying", "installing", "queued"].includes(item.state))
    return 1;
  if (isActionable(item)) return 2;
  if (item.state === "checking" || item.state === "idle") return 3;
  return 4;
}

function formatEta(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "计算中";
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function StatusBadge({ item }: { item: SyncItem }) {
  if (item.state === "idle") {
    return (
      <span className="status-badge idle">
        <Search size={13} /> 待扫描
      </span>
    );
  }
  if (item.state === "checking") {
    return (
      <span className="status-badge checking">
        <Loader2 size={13} className="spin" /> 检查中
      </span>
    );
  }
  if (item.state === "current") {
    return (
      <span className="status-badge current">
        <CheckCircle2 size={13} /> 已是最新
      </span>
    );
  }
  if (item.state === "outdated") {
    return (
      <span className="status-badge outdated">
        <ArrowDownToLine size={13} /> 需要更新
      </span>
    );
  }
  if (item.state === "missing") {
    return (
      <span className="status-badge missing">
        <FileClock size={13} /> 本地缺失
      </span>
    );
  }
  if (item.state === "queued") {
    return <span className="status-badge queued">等待中</span>;
  }
  if (
    item.state === "downloading" ||
    item.state === "verifying" ||
    item.state === "installing"
  ) {
    const percent =
      item.state === "downloading" && item.transferred
        ? Math.min(100, Math.round((item.transferred / item.fileSize) * 100))
        : undefined;
    return (
      <span className="status-badge downloading">
        <Loader2 size={13} className="spin" />
        {item.state === "verifying"
          ? "校验中"
          : item.state === "installing"
            ? "写入中"
            : `下载 ${percent ?? 0}%`}
      </span>
    );
  }
  if (item.state === "done") {
    return (
      <span className="status-badge current">
        <CheckCircle2 size={13} /> 更新完成
      </span>
    );
  }
  return (
    <span className="status-badge error" title={item.error}>
      <AlertCircle size={13} /> 需要重试
    </span>
  );
}

function EmptyActivity() {
  return (
    <div className="empty-activity">
      <div className="empty-orbit">
        <Activity size={22} />
      </div>
      <strong>还没有更新记录</strong>
      <span>扫描目录后，这里会显示同步结果。</span>
    </div>
  );
}

export default function App() {
  const isDesktop = Boolean(window.tmpDesktop?.isDesktop);
  const baseUrl = DEFAULT_API_BASE;
  const [items, setItems] = useState<SyncItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter | null>(null);
  const [search, setSearch] = useState("");
  const [directoryName, setDirectoryName] = useState("尚未选择目录");
  const [installPath, setInstallPath] = useState("");
  const [installationSource, setInstallationSource] = useState<
    "auto" | "manual" | "browser" | null
  >(null);
  const [hasDirectory, setHasDirectory] = useState(false);
  const [directoryNeedsPermission, setDirectoryNeedsPermission] =
    useState(false);
  const [sourceState, setSourceState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [sourceError, setSourceError] = useState("");
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [scanProgress, setScanProgress] = useState<ScanProgress>({
    done: 0,
    total: 0,
    hashing: 0,
  });
  const [isScanning, setIsScanning] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isDetecting, setIsDetecting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [lastScannedAt, setLastScannedAt] = useState<Date | null>(null);
  const [detailPath, setDetailPath] = useState<string | null>(null);
  const [activityExpanded, setActivityExpanded] = useState(false);
  const [activeSection, setActiveSection] = useState("overview");
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(
    null,
  );
  const [activities, setActivities] = useState<ActivityEntry[]>([]);
  const [guideOpen, setGuideOpen] = useState(false);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [autoDetect, setAutoDetect] = useState(
    () => localStorage.getItem(AUTO_DETECT_STORAGE_KEY) !== "false",
  );
  const [backgroundMode, setBackgroundMode] = useState(true);
  const [appUpdate, setAppUpdate] = useState<AppUpdateState>({ status: "idle" });
  const [lastDetectedAt, setLastDetectedAt] = useState<Date | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });

  const directoryRef = useRef<FileSystemDirectoryHandle | null>(null);
  const installPathRef = useRef("");
  const localHandlesRef = useRef<Map<string, FileSystemFileHandle>>(new Map());
  const fingerprintsRef = useRef<Record<string, FileRecord>>({});
  const scanAbortRef = useRef<AbortController | null>(null);
  const updateAbortRef = useRef<AbortController | null>(null);
  const operationRef = useRef(false);
  const noticeTimerRef = useRef<number>();

  useEffect(() => {
    if (window.tmpDesktop?.getBackgroundMode) {
      void window.tmpDesktop.getBackgroundMode().then((result) => setBackgroundMode(result.backgroundMode)).catch(() => undefined);
    }
  }, []);

  const addActivity = useCallback(
    (message: string, level: ActivityEntry["level"] = "info") => {
      setActivities((previous) =>
        [
          {
            id: Date.now() + Math.random(),
            time: formatClock(),
            message,
            level,
          },
          ...previous,
        ].slice(0, 40),
      );
    },
    [],
  );

  const showNotice = useCallback((message: string) => {
    window.clearTimeout(noticeTimerRef.current);
    setNotice(message);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 4500);
  }, []);

  const openRepository = useCallback(async (url: string) => {
    try {
      if (window.tmpDesktop?.openExternal) {
        await window.tmpDesktop.openExternal(url);
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    } catch (error) {
      showNotice(`无法打开链接：${(error as Error).message}`);
    }
  }, [showNotice]);

  const checkAppUpdate = useCallback(async () => {
    if (!window.tmpDesktop?.checkAppUpdate) {
      setAppUpdate({ status: "current", message: "浏览器模式不支持更新软件本体，请使用桌面版" });
      return;
    }
    setAppUpdate({ status: "checking", message: "正在检查 CNB 最新版本…" });
    try {
      const result = await window.tmpDesktop.checkAppUpdate();
      setAppUpdate({
        status: result.ok ? (result.available ? "available" : "current") : "error",
        latestVersion: result.latestVersion,
        releaseUrl: result.releaseUrl,
        message: result.message,
      });
      if (result.ok && result.available) showNotice(`发现软件新版本 v${result.latestVersion}，可在“关于与使用说明”中安装`);
    } catch (error) {
      setAppUpdate({ status: "error", message: (error as Error).message });
    }
  }, [showNotice]);

  const installAppUpdate = useCallback(async () => {
    if (!window.tmpDesktop?.installAppUpdate) return;
    setAppUpdate((current) => ({ ...current, status: "installing", message: "正在下载 CNB 安装包…" }));
    try {
      const result = await window.tmpDesktop.installAppUpdate();
      if (!result.ok) {
        setAppUpdate((current) => ({ ...current, status: "available", message: result.message }));
        return;
      }
      setAppUpdate((current) => ({ ...current, message: result.message }));
      showNotice(result.message);
    } catch (error) {
      setAppUpdate((current) => ({ ...current, status: "available", message: (error as Error).message }));
    }
  }, [showNotice]);

  useEffect(() => {
    if (!window.tmpDesktop?.checkAppUpdate) return;
    const timer = window.setTimeout(() => void checkAppUpdate(), 2500);
    return () => window.clearTimeout(timer);
  }, [checkAppUpdate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setGuideOpen(false);
      setConfirmState(null);
      setDetailPath(null);
      setSidebarOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.clearTimeout(noticeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.find((entry) => entry.isIntersecting);
        if (visible) setActiveSection(visible.target.id);
      },
      { rootMargin: "-80px 0px -55% 0px" },
    );
    ["overview", "files", "activity"].forEach((id) => {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!guideOpen && !confirmState && !detailPath) return;
    const previous = document.activeElement as HTMLElement | null;
    const modal = document.querySelector<HTMLElement>(".modal");
    const selector =
      'button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]';
    const controls = () => [
      ...(modal?.querySelectorAll<HTMLElement>(selector) ?? []),
    ];
    controls()[0]?.focus();
    const onTab = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const elements = controls();
      const first = elements[0];
      const last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onTab);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener("keydown", onTab);
      previous?.focus();
    };
  }, [guideOpen, confirmState, detailPath]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#0e1217" : "#f3f1ec");
  }, [theme]);

  const applyInstallPath = useCallback(
    (nextPath: string, source: "auto" | "manual") => {
      const normalized = nextPath.replace(/[\\/]+$/, "");
      installPathRef.current = normalized;
      setInstallPath(normalized);
      setDirectoryName(
        normalized.split(/[\\/]/).filter(Boolean).at(-1) || "TruckersMP",
      );
      setInstallationSource(source);
      setHasDirectory(true);
      setDirectoryNeedsPermission(false);
      setLastDetectedAt(new Date());
    },
    [],
  );

  const scanNativeClient = useCallback(
    async (
      remoteFiles: SyncItem[],
      nativeInstallPath: string,
      source: "auto" | "manual" = "auto",
    ) => {
      if (!window.tmpDesktop) return;
      setIsScanning(true);
      setStatusFilter(null);
      setLastScannedAt(null);
      setUpdateProgress(null);
      setScanProgress({ done: 0, total: remoteFiles.length, hashing: 0 });
      setItems(remoteFiles.map((file) => ({ ...file, state: "checking" })));
      setSelected(new Set());
      try {
        const result = await window.tmpDesktop.scan({
          installPath: nativeInstallPath,
          baseUrl,
          force: true,
        });
        if (!result.ok) throw new Error(result.message || "自动扫描失败");
        const scanned = result.files;
        const needed = new Set(
          scanned.filter(isActionable).map((item) => item.filePath),
        );
        setItems(scanned);
        setSelected(needed);
        if (result.installPath) applyInstallPath(result.installPath, source);
        setScanProgress({
          done: scanned.length,
          total: scanned.length,
          hashing: 0,
        });
        setLastScannedAt(new Date());
        const currentCount = scanned.filter(
          (item) => item.state === "current",
        ).length;
        const failed = scanned.filter((item) => item.state === "error").length;
        addActivity(
          `自动扫描完成：${currentCount} 个文件已是最新，${needed.size} 个需要更新${
            failed ? `，${failed} 个检查失败` : ""
          }`,
          failed ? "warning" : "success",
        );
        return scanned;
      } catch (error) {
        setItems(remoteFiles.map((file) => ({ ...file, state: "idle" })));
        addActivity(`自动扫描失败：${(error as Error).message}`, "error");
        throw error;
      } finally {
        setIsScanning(false);
      }
    },
    [addActivity, applyInstallPath, baseUrl],
  );

  const scanDirectory = useCallback(
    async (remoteFiles: SyncItem[], directory: FileSystemDirectoryHandle) => {
      scanAbortRef.current?.abort();
      const controller = new AbortController();
      scanAbortRef.current = controller;
      setIsScanning(true);
      setStatusFilter(null);
      setLastScannedAt(null);
      setUpdateProgress(null);
      localHandlesRef.current.clear();
      fingerprintsRef.current = await loadFingerprints(directory).catch(
        () => ({}),
      );
      setScanProgress({ done: 0, total: remoteFiles.length, hashing: 0 });
      setItems(remoteFiles.map((file) => ({ ...file, state: "checking" })));
      setSelected(new Set());

      const needed = new Set<string>();
      let completed = 0;
      let hashing = 0;
      let nextIndex = 0;
      let failed = 0;

      const updateOne = async (file: SyncItem) => {
        try {
          const handle = await resolveFileHandle(directory, file.filePath);
          if (!handle) {
            needed.add(file.filePath);
            setItems((current) =>
              current.map((item) =>
                item.filePath === file.filePath
                  ? {
                      ...item,
                      state: "missing",
                      localSize: undefined,
                      localMd5: undefined,
                    }
                  : item,
              ),
            );
            return;
          }

          localHandlesRef.current.set(file.filePath, handle);
          const localFile = await handle.getFile();
          if (localFile.size !== file.fileSize) {
            needed.add(file.filePath);
            setItems((current) =>
              current.map((item) =>
                item.filePath === file.filePath
                  ? {
                      ...item,
                      state: "outdated",
                      localSize: localFile.size,
                      localMd5: undefined,
                    }
                  : item,
              ),
            );
            return;
          }

          const signature = makeFileSignature(
            localFile.size,
            localFile.lastModified,
          );
          const cached = fingerprintsRef.current[file.filePath];
          let localMd5: string;
          if (cached && `${cached.size}:${cached.lastModified}` === signature) {
            localMd5 = cached.md5;
          } else {
            hashing += 1;
            setScanProgress({
              done: completed,
              total: remoteFiles.length,
              hashing,
            });
            localMd5 = await hashFile(localFile, controller.signal);
            fingerprintsRef.current[file.filePath] = {
              size: localFile.size,
              lastModified: localFile.lastModified,
              md5: localMd5,
            };
          }

          const current = localMd5.toLowerCase() === file.md5.toLowerCase();
          if (!current) needed.add(file.filePath);
          setItems((previous) =>
            previous.map((item) =>
              item.filePath === file.filePath
                ? {
                    ...item,
                    state: current ? "current" : "outdated",
                    localSize: localFile.size,
                    localMd5,
                  }
                : item,
            ),
          );
        } catch (error) {
          if (controller.signal.aborted) return;
          failed += 1;
          setItems((current) =>
            current.map((item) =>
              item.filePath === file.filePath
                ? { ...item, state: "error", error: (error as Error).message }
                : item,
            ),
          );
        } finally {
          completed += 1;
          setScanProgress({
            done: completed,
            total: remoteFiles.length,
            hashing,
          });
        }
      };

      const worker = async () => {
        while (true) {
          if (controller.signal.aborted) return;
          const index = nextIndex++;
          if (index >= remoteFiles.length) return;
          await updateOne(remoteFiles[index]);
        }
      };

      try {
        await Promise.all(Array.from({ length: 4 }, worker));
        if (controller.signal.aborted) return;
        setSelected(needed);
        await saveFingerprints(directory, fingerprintsRef.current).catch(
          () => undefined,
        );
        setLastScannedAt(new Date());
        const currentCount = remoteFiles.length - needed.size - failed;
        addActivity(
          `扫描完成：${currentCount} 个文件已是最新，${needed.size} 个需要更新${
            failed ? `，${failed} 个检查失败` : ""
          }`,
          failed ? "warning" : "success",
        );
      } finally {
        if (!controller.signal.aborted) setIsScanning(false);
      }
    },
    [addActivity],
  );

  const refreshSource = useCallback(
    async (nextBase = baseUrl, directory = directoryRef.current) => {
      if (operationRef.current) return;
      operationRef.current = true;
      setSourceState("loading");
      setSourceError("");
      let sourceLoaded = false;
      try {
        const files = await fetchTmpFiles(nextBase);
        if (window.tmpDesktop && installationSource !== "manual") {
          setIsDetecting(true);
          const detection = await window.tmpDesktop.detectInstallPath();
          setLastDetectedAt(new Date());
          if (detection.ok && detection.installPath) {
            applyInstallPath(detection.installPath, "auto");
          } else {
            installPathRef.current = "";
            setInstallPath("");
            setHasDirectory(false);
            setLastScannedAt(null);
            setDirectoryName("未检测到 TruckersMP");
          }
          setIsDetecting(false);
        }
        const hasNativeClient = Boolean(
          window.tmpDesktop && installPathRef.current,
        );
        const syncFiles = files.map<SyncItem>((file) => ({
          ...file,
          state: directory || hasNativeClient ? "checking" : "idle",
        }));
        setItems(syncFiles);
        setSelected(new Set());
        setSourceState("ready");
        sourceLoaded = true;
        setLastRefreshed(new Date());
        addActivity(`已同步文件清单，共 ${files.length} 个文件`, "info");
        if (window.tmpDesktop && installPathRef.current && !isUpdating) {
          await scanNativeClient(
            syncFiles,
            installPathRef.current,
            installationSource === "manual" ? "manual" : "auto",
          );
        } else if (directory && !isUpdating) {
          await scanDirectory(syncFiles, directory);
        }
      } catch (error) {
        if ((error as Error).name === "AbortError") return;
        if (document.hidden && window.tmpDesktop?.reportCheckError) {
          void window.tmpDesktop.reportCheckError((error as Error).message);
        }
        if (!sourceLoaded) {
          setSourceState("error");
          setSourceError((error as Error).message);
          addActivity(`获取文件清单失败：${(error as Error).message}`, "error");
        } else {
          showNotice(`扫描失败：${(error as Error).message}`);
        }
      } finally {
        setIsDetecting(false);
        operationRef.current = false;
      }
    },
    [
      addActivity,
      applyInstallPath,
      baseUrl,
      installationSource,
      isUpdating,
      scanDirectory,
      scanNativeClient,
      showNotice,
    ],
  );

  useEffect(() => {
    let active = true;

    async function bootstrap() {
      operationRef.current = true;
      try {
        setSourceState("loading");
        const [filesResult, clientResult] = await Promise.allSettled([
          fetchTmpFiles(DEFAULT_API_BASE),
          window.tmpDesktop
            ? window.tmpDesktop.detectInstallPath()
            : loadDirectoryHandle(),
        ]);
        if (!active) return;

        let remoteFiles: SyncItem[] | null = null;
        if (filesResult.status === "fulfilled") {
          remoteFiles = filesResult.value.map((file) => ({
            ...file,
            state: "idle",
          }));
          setItems(remoteFiles);
          setSourceState("ready");
          setLastRefreshed(new Date());
        } else {
          setSourceState("error");
          setSourceError((filesResult.reason as Error).message);
        }

        if (window.tmpDesktop && clientResult.status === "fulfilled") {
          const detection = clientResult.value as DesktopDetectionResult;
          if (detection.ok && detection.installPath) {
            applyInstallPath(detection.installPath, "auto");
            addActivity(detection.message, "success");
            if (active && remoteFiles) {
              await scanNativeClient(remoteFiles, detection.installPath);
            }
          } else {
            setHasDirectory(false);
            setDirectoryName("未检测到 TruckersMP");
            addActivity(detection.message, "warning");
          }
        } else if (clientResult.status === "fulfilled" && clientResult.value) {
          const handle = clientResult.value as FileSystemDirectoryHandle;
          directoryRef.current = handle;
          setHasDirectory(true);
          setDirectoryName(handle.name);
          setInstallationSource("browser");
          const permitted = await ensurePermission(handle);
          setDirectoryNeedsPermission(!permitted);
          if (active && permitted && remoteFiles) {
            await scanDirectory(remoteFiles, handle);
          }
        }
      } catch (error) {
        if (active) showNotice(`初始化未完成：${(error as Error).message}`);
      } finally {
        operationRef.current = false;
      }
    }

    void bootstrap();
    return () => {
      active = false;
      scanAbortRef.current?.abort();
      updateAbortRef.current?.abort();
    };
    // Bootstrap only runs once. Later refreshes are explicit user actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chooseDirectory = useCallback(async () => {
    if (operationRef.current) return;
    operationRef.current = true;
    setIsDetecting(true);
    try {
      if (window.tmpDesktop) {
        try {
          const result = await window.tmpDesktop.chooseInstallPath();
          if (!result.ok) {
            if (!result.cancelled) showNotice(result.message);
            return;
          }
          applyInstallPath(result.installPath, "manual");
          addActivity(`已选择 TruckersMP 目录：${result.installPath}`, "info");
          if (items.length)
            await scanNativeClient(items, result.installPath, "manual");
        } catch (error) {
          showNotice(`无法打开目录：${(error as Error).message}`);
        }
        return;
      }
      if (!window.showDirectoryPicker) {
        showNotice("当前浏览器不支持目录写入，请使用最新版 Chrome 或 Edge");
        return;
      }

      try {
        const handle = await window.showDirectoryPicker({
          id: "tmp-client-directory",
          mode: "readwrite",
          startIn: "documents",
        });
        const permitted = await ensurePermission(handle, true);
        if (!permitted) {
          showNotice("未获得目录读写权限");
          return;
        }
        directoryRef.current = handle;
        setHasDirectory(true);
        setDirectoryNeedsPermission(false);
        setDirectoryName(handle.name);
        setInstallationSource("browser");
        await saveDirectoryHandle(handle);
        addActivity(`已选择客户端目录：${handle.name}`, "info");
        if (items.length) await scanDirectory(items, handle);
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          showNotice(`无法打开目录：${(error as Error).message}`);
        }
      }
    } finally {
      setIsDetecting(false);
      operationRef.current = false;
    }
  }, [
    addActivity,
    applyInstallPath,
    isUpdating,
    items,
    scanDirectory,
    scanNativeClient,
    showNotice,
  ]);

  const requestReconnect = useCallback(async () => {
    if (operationRef.current) return;
    if (!window.tmpDesktop && !directoryRef.current) {
      await chooseDirectory();
      return;
    }
    operationRef.current = true;
    setIsDetecting(true);
    try {
      if (window.tmpDesktop) {
        try {
          const detection = await window.tmpDesktop.detectInstallPath();
          setLastDetectedAt(new Date());
          if (!detection.ok) {
            setHasDirectory(false);
            setDirectoryName("未检测到 TruckersMP");
            installPathRef.current = "";
            setInstallPath("");
            setItems((current) =>
              current.map((item) => ({ ...item, state: "idle" })),
            );
            setSelected(new Set());
            setLastScannedAt(null);
            showNotice(detection.message);
            return;
          }
          applyInstallPath(detection.installPath, "auto");
          addActivity(detection.message, "success");
          if (items.length)
            await scanNativeClient(items, detection.installPath);
        } catch (error) {
          showNotice(`自动检测失败：${(error as Error).message}`);
        }
        return;
      }
      const handle = directoryRef.current;
      if (!handle) {
        await chooseDirectory();
        return;
      }
      const permitted = await ensurePermission(handle, true);
      setDirectoryNeedsPermission(!permitted);
      if (permitted && items.length) await scanDirectory(items, handle);
    } catch (error) {
      showNotice(`扫描失败：${(error as Error).message}`);
    } finally {
      setIsDetecting(false);
      operationRef.current = false;
    }
  }, [
    addActivity,
    applyInstallPath,
    chooseDirectory,
    items,
    scanDirectory,
    scanNativeClient,
    showNotice,
  ]);

  const effectiveStatusFilter: StatusFilter =
    statusFilter ?? (lastScannedAt && items.some(isPending) ? "needs" : "all");

  const filteredItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    return items
      .filter((item) => {
        const typeMatches =
          typeFilter === "all" ||
          (typeFilter === "system" && item.type === 1) ||
          (typeFilter === "ets2" && item.type === 2) ||
          (typeFilter === "ats" && item.type === 3);
        return (
          typeMatches &&
          matchesStatus(item, effectiveStatusFilter) &&
          (!query || item.filePath.toLowerCase().includes(query))
        );
      })
      .sort(
        (a, b) =>
          stateOrder(a) - stateOrder(b) || a.filePath.localeCompare(b.filePath),
      );
  }, [items, search, typeFilter, effectiveStatusFilter]);

  const stats = useMemo(() => {
    const needs = items.filter(isPending);
    const current = items.filter(
      (item) => item.state === "current" || item.state === "done",
    );
    return {
      needs: needs.length,
      current: current.length,
      needsBytes: needs.reduce((sum, item) => sum + item.fileSize, 0),
      totalBytes: items.reduce((sum, item) => sum + item.fileSize, 0),
      errors: items.filter((item) => item.state === "error").length,
    };
  }, [items]);

  const visibleActionable = useMemo(
    () => filteredItems.filter(isActionable),
    [filteredItems],
  );
  const allVisibleSelected =
    visibleActionable.length > 0 &&
    visibleActionable.every((item) => selected.has(item.filePath));

  const toggleSelected = (filePath: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  };

  const toggleAllVisible = () => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (allVisibleSelected) {
        visibleActionable.forEach((item) => next.delete(item.filePath));
      } else {
        visibleActionable.forEach((item) => next.add(item.filePath));
      }
      return next;
    });
  };

  const requestBatchUpdate = useCallback(
    async (paths?: string[]) => {
      if (operationRef.current || isUpdating) return;
      if (
        (window.tmpDesktop && !installPathRef.current) ||
        (!window.tmpDesktop && !directoryRef.current)
      ) {
        await chooseDirectory();
        if (directoryRef.current || installPathRef.current) {
          showNotice("目录已连接，请确认需要更新的文件");
        }
        return;
      }
      const requiresScan = !items.some((item) =>
        ["current", "outdated", "missing", "done", "error"].includes(
          item.state,
        ),
      );
      if (directoryNeedsPermission || requiresScan) {
        await requestReconnect();
        if (requiresScan) showNotice("扫描完成，请确认需要更新的文件");
        return;
      }
      const requestedPaths =
        paths ?? items.filter(isActionable).map((item) => item.filePath);
      const actionablePaths = requestedPaths.filter((path) =>
        items.some((item) => item.filePath === path && isActionable(item)),
      );
      if (!actionablePaths.length) {
        showNotice("没有需要更新的文件");
        return;
      }
      if (!window.tmpDesktop) {
        const permitted = await ensurePermission(directoryRef.current!, true);
        setDirectoryNeedsPermission(!permitted);
        if (!permitted) {
          showNotice("需要目录读写权限才能更新文件");
          return;
        }
      }
      const bytes = items
        .filter((item) => actionablePaths.includes(item.filePath))
        .reduce((sum, item) => sum + item.fileSize, 0);
      setConfirmState({ paths: actionablePaths, bytes });
    },
    [
      chooseDirectory,
      directoryNeedsPermission,
      isUpdating,
      items,
      requestReconnect,
      showNotice,
    ],
  );

  const runUpdate = useCallback(
    async (paths: string[]) => {
      const directory = directoryRef.current;
      const nativeInstallPath = installPathRef.current;
      if (
        (!directory && !nativeInstallPath) ||
        operationRef.current ||
        isUpdating ||
        !paths.length
      )
        return;

      const targets = items.filter(
        (item) => paths.includes(item.filePath) && isActionable(item),
      );
      if (!targets.length) return;
      operationRef.current = true;
      setIsCancelling(false);

      if (window.tmpDesktop && nativeInstallPath) {
        setConfirmState(null);
        setIsUpdating(true);
        setSelected(new Set());
        const bytesTotal = targets.reduce(
          (sum, item) => sum + item.fileSize,
          0,
        );
        setUpdateProgress({
          completed: 0,
          total: targets.length,
          currentNames: [],
          bytesDone: 0,
          bytesTotal,
        });
        setItems((current) =>
          current.map((item) =>
            paths.includes(item.filePath) && isActionable(item)
              ? { ...item, state: "queued", error: undefined, transferred: 0 }
              : item,
          ),
        );
        addActivity(`开始更新 ${targets.length} 个文件`, "info");
        try {
          const result = await window.tmpDesktop.update({
            installPath: nativeInstallPath,
            baseUrl,
            paths,
          });
          for (const failure of result.errors) {
            addActivity(
              `${failure.filePath} 更新失败：${failure.message}`,
              "error",
            );
          }
          addActivity(
            result.message,
            result.ok ? "success" : result.cancelled ? "warning" : "error",
          );
          showNotice(result.message);
          if (items.length) {
            await scanNativeClient(
              items,
              nativeInstallPath,
              installationSource === "manual" ? "manual" : "auto",
            );
            if (result.errors.length) {
              setItems((current) =>
                current.map((item) => {
                  const failure = result.errors.find(
                    (entry) => entry.filePath === item.filePath,
                  );
                  return failure
                    ? { ...item, state: "error", error: failure.message }
                    : item;
                }),
              );
            }
          }
        } catch (error) {
          setItems((current) =>
            current.map((item) => {
              const original = targets.find(
                (target) => target.filePath === item.filePath,
              );
              return original &&
                ["queued", "downloading", "installing", "verifying"].includes(
                  item.state,
                )
                ? {
                    ...original,
                    state: "error",
                    error: (error as Error).message,
                  }
                : item;
            }),
          );
          addActivity(`更新失败：${(error as Error).message}`, "error");
          showNotice(`更新失败：${(error as Error).message}`);
        } finally {
          setIsUpdating(false);
          setUpdateProgress(null);
          setIsCancelling(false);
          operationRef.current = false;
          updateAbortRef.current = null;
        }
        return;
      }
      if (!directory) {
        operationRef.current = false;
        return;
      }

      setConfirmState(null);
      setIsUpdating(true);
      setSelected(new Set());
      const controller = new AbortController();
      updateAbortRef.current = controller;
      const bytesTotal = targets.reduce((sum, item) => sum + item.fileSize, 0);
      const transferred = new Map<string, number>(
        targets.map((item) => [item.filePath, 0]),
      );
      const speeds = new Map<string, number>();
      let phase: UpdateProgress["phase"] = "downloading";
      let progressMessage = "";
      const currentNames = new Set<string>();
      let completed = 0;
      let succeeded = 0;
      const failures = new Map<string, string>();
      let nextIndex = 0;

      const publishProgress = () => {
        const bytesDone = [...transferred.values()].reduce(
          (sum, value) => sum + value,
          0,
        );
        const speed = [...speeds.values()].reduce((sum, value) => sum + value, 0);
        setUpdateProgress({
          completed,
          total: targets.length,
          currentNames: [...currentNames],
          bytesDone: Math.min(bytesDone, bytesTotal),
          bytesTotal,
          speed,
          etaSeconds: speed > 0 ? Math.ceil((bytesTotal - bytesDone) / speed) : null,
          phase,
          message: progressMessage,
        });
      };

      setItems((current) =>
        current.map((item) =>
          paths.includes(item.filePath) && isActionable(item)
            ? { ...item, state: "queued", error: undefined, transferred: 0 }
            : item,
        ),
      );
      publishProgress();
      addActivity(`开始更新 ${targets.length} 个文件`, "info");

      const runOne = async (target: SyncItem) => {
        if (controller.signal.aborted) return;
        currentNames.add(target.filePath);
        publishProgress();

        try {
          await downloadAndInstall(
            directory,
            target,
            buildDownloadUrl(baseUrl, target),
            controller.signal,
            {
              onProgress: (done, _total, speed) => {
                phase = "downloading";
                transferred.set(target.filePath, done);
                speeds.set(target.filePath, speed);
                setItems((current) =>
                  current.map((item) =>
                    item.filePath === target.filePath
                      ? {
                          ...item,
                          state: "downloading",
                          transferred: done,
                          speed,
                          error: undefined,
                        }
                      : item,
                  ),
                );
                publishProgress();
              },
              onVerifying: () => {
                phase = "verifying";
                speeds.delete(target.filePath);
                transferred.set(target.filePath, target.fileSize);
                setItems((current) =>
                  current.map((item) =>
                    item.filePath === target.filePath
                      ? { ...item, state: "verifying" }
                      : item,
                  ),
                );
                publishProgress();
              },
              onInstalling: () => {
                phase = "installing";
                publishProgress();
                setItems((current) =>
                  current.map((item) =>
                    item.filePath === target.filePath
                      ? { ...item, state: "installing" }
                      : item,
                  ),
                );
              },
              onRetry: (attempt, reason) => {
                phase = "retrying";
                progressMessage = `${reason}，正在第 ${attempt} 次尝试`;
                transferred.set(target.filePath, 0);
                speeds.delete(target.filePath);
                publishProgress();
                addActivity(`${target.filePath} 下载重试（${attempt}/3）：${reason}`, "warning");
              },
            },
          );

          const newHandle = await resolveFileHandle(directory, target.filePath);
          if (newHandle)
            localHandlesRef.current.set(target.filePath, newHandle);
          if (newHandle) {
            const installed = await newHandle.getFile();
            fingerprintsRef.current[target.filePath] = {
              size: installed.size,
              lastModified: installed.lastModified,
              md5: target.md5,
            };
          }
          transferred.set(target.filePath, target.fileSize);
          setItems((current) =>
            current.map((item) =>
              item.filePath === target.filePath
                ? { ...item, state: "done", transferred: target.fileSize }
                : item,
            ),
          );
          succeeded += 1;
          addActivity(`已更新 ${target.filePath}`, "success");
        } catch (error) {
          const cancelled = (error as Error).name === "AbortError";
          transferred.set(target.filePath, 0);
          setItems((current) =>
            current.map((item) =>
              item.filePath === target.filePath
                ? {
                    ...item,
                    state: cancelled ? target.state : "error",
                    error: cancelled ? "已取消" : (error as Error).message,
                  }
                : item,
            ),
          );
          if (!cancelled) {
            failures.set(target.filePath, (error as Error).message);
            addActivity(
              `${target.filePath} 更新失败：${(error as Error).message}`,
              "error",
            );
          }
          publishProgress();
        } finally {
          speeds.delete(target.filePath);
          currentNames.delete(target.filePath);
          completed += 1;
          publishProgress();
        }
      };

      const worker = async () => {
        while (true) {
          if (controller.signal.aborted) return;
          const index = nextIndex++;
          if (index >= targets.length) return;
          await runOne(targets[index]);
        }
      };

      try {
        await Promise.all(
          Array.from(
            { length: Math.min(UPDATE_CONCURRENCY, targets.length) },
            worker,
          ),
        );
        if (controller.signal.aborted) {
          setItems((current) =>
            current.map((item) =>
              item.state === "queued"
                ? {
                    ...item,
                    state:
                      targets.find(
                        (target) => target.filePath === item.filePath,
                      )?.state ?? "idle",
                    error: "已取消",
                  }
                : item,
            ),
          );
        }
        await saveFingerprints(directory, fingerprintsRef.current).catch(
          () => undefined,
        );
        const cancelled = controller.signal.aborted;
        addActivity(
          cancelled
            ? `更新已停止，已完成 ${succeeded} 个文件`
            : `更新完成：成功 ${succeeded}/${targets.length} 个文件`,
          cancelled
            ? "warning"
            : succeeded === targets.length
              ? "success"
              : "warning",
        );
        if (!cancelled) {
          showNotice(
            succeeded === targets.length
              ? `已成功更新 ${succeeded} 个文件`
              : `已更新 ${succeeded}/${targets.length} 个文件`,
          );
        }
        await scanDirectory(items, directory);
        if (failures.size) {
          setItems((current) =>
            current.map((item) =>
              failures.has(item.filePath)
                ? {
                    ...item,
                    state: "error",
                    error: failures.get(item.filePath),
                  }
                : item,
            ),
          );
        }
      } finally {
        setIsUpdating(false);
        updateAbortRef.current = null;
        setUpdateProgress(null);
        setIsCancelling(false);
        operationRef.current = false;
      }
    },
    [
      addActivity,
      baseUrl,
      installationSource,
      isUpdating,
      items,
      scanNativeClient,
      scanDirectory,
      showNotice,
    ],
  );

  const cancelUpdate = async () => {
    if (isCancelling) return;
    setIsCancelling(true);
    try {
      if (window.tmpDesktop) await window.tmpDesktop.cancelUpdate();
      else updateAbortRef.current?.abort();
      addActivity("正在停止更新…", "warning");
    } catch (error) {
      setIsCancelling(false);
      showNotice(`停止失败：${(error as Error).message}`);
    }
  };

  const exportDiagnostics = async () => {
    const snapshot = {
      sourceState,
      lastScannedAt: lastScannedAt?.toISOString() || "",
      files: items.map((item) => ({ path: item.filePath, state: item.state, error: item.error || "" })),
      activities: activities.map((entry) => ({ time: entry.time, level: entry.level, message: entry.message })),
    };
    try {
      if (window.tmpDesktop?.exportDiagnostics) {
        const result = await window.tmpDesktop.exportDiagnostics(snapshot);
        if (result.ok) showNotice("诊断日志已导出");
      } else {
        const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), appVersion: APP_VERSION, ...snapshot }, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `TMP-Diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        showNotice("诊断日志已导出");
      }
    } catch (error) {
      showNotice(`导出失败：${(error as Error).message}`);
    }
  };

  useEffect(() => {
    if (!window.tmpDesktop) return;
    return window.tmpDesktop.onProgress((progress) => {
      setUpdateProgress({
        completed: progress.completed,
        total: progress.totalFiles,
        currentNames: progress.filePath ? [progress.filePath] : [],
        bytesDone: progress.overallDownloaded,
        bytesTotal: progress.overallTotalBytes,
        speed: progress.speed,
        etaSeconds: progress.etaSeconds,
        phase: progress.phase,
        message: progress.message,
      });
      if (progress.filePath) {
        setItems((current) =>
          current.map((item) =>
            item.filePath === progress.filePath
              ? {
                  ...item,
                  state:
                    progress.phase === "done"
                      ? "done"
                      : progress.phase === "retrying"
                        ? "queued"
                      : progress.phase === "verifying"
                        ? "verifying"
                        : progress.phase === "installing"
                          ? "installing"
                          : "downloading",
                  transferred: progress.downloaded,
                  error: undefined,
                }
              : item,
          ),
        );
      }
    });
  }, []);

  useEffect(() => {
    localStorage.setItem(AUTO_DETECT_STORAGE_KEY, String(autoDetect));
  }, [autoDetect]);

  useEffect(() => {
    if (!window.tmpDesktop || !autoDetect || confirmState || detailPath) return;
    const timer = window.setInterval(() => {
      if (!operationRef.current) void refreshSource();
    }, AUTO_DETECT_INTERVAL);
    return () => window.clearInterval(timer);
  }, [
    autoDetect,
    confirmState,
    detailPath,
    installationSource,
    isScanning,
    isUpdating,
    refreshSource,
    requestReconnect,
  ]);

  const updatePercent = updateProgress
    ? Math.min(
        100,
        Math.round(
          (updateProgress.bytesDone / Math.max(1, updateProgress.bytesTotal)) *
            100,
        ),
      )
    : 0;

  const filterCounts = {
    all: items.length,
    system: items.filter((item) => item.type === 1).length,
    ets2: items.filter((item) => item.type === 2).length,
    ats: items.filter((item) => item.type === 3).length,
  };
  const busy =
    isScanning || isUpdating || isDetecting || sourceState === "loading";
  const hasScan = lastScannedAt !== null;
  const isCurrent =
    hasScan && stats.current === items.length && items.length > 0;
  const selectedItems = items.filter(
    (item) => selected.has(item.filePath) && isActionable(item),
  );
  const selectedBytes = selectedItems.reduce(
    (sum, item) => sum + item.fileSize,
    0,
  );
  const detailItem = items.find((item) => item.filePath === detailPath);
  const healthTitle = isScanning
    ? "正在检查客户端文件"
    : isUpdating
      ? isCancelling
        ? "正在安全停止更新"
        : updateProgress?.phase === "retrying"
          ? "下载中断，正在自动重试"
          : updateProgress?.phase === "verifying"
            ? "正在校验下载文件"
            : updateProgress?.phase === "installing"
              ? "正在安装已校验文件"
              : "正在下载更新"
      : sourceState === "loading" || isDetecting
        ? "正在准备文件检查"
        : sourceState === "error"
          ? "文件清单连接失败"
          : !hasDirectory
            ? "连接客户端，开始检查更新"
            : !hasScan
              ? "目录已连接，等待检查"
              : stats.errors
                ? `${stats.errors} 个文件检查或更新失败`
                : stats.needs
                  ? `发现 ${stats.needs} 个待更新文件`
                  : "客户端已是最新版本";
  const healthDescription = isScanning
    ? isDesktop
      ? "正在核对文件大小与 MD5，请稍候。"
      : `已检查 ${scanProgress.done} / ${scanProgress.total} 个文件`
    : isUpdating
      ? updateProgress
        ? `${formatBytes(updateProgress.bytesDone)} / ${formatBytes(updateProgress.bytesTotal)} · ${formatBytes(updateProgress.speed || 0)}/s · 剩余 ${formatEta(updateProgress.etaSeconds)} · 已完成 ${updateProgress.completed}/${updateProgress.total}`
        : "正在准备更新文件…"
      : sourceState === "error"
        ? "请检查网络后重试，已有文件不会受到影响。"
        : !hasDirectory
          ? isDesktop
            ? "支持自动检测 TruckersMP，也可以手动选择安装目录。"
            : "选择 TruckersMP 客户端目录后，自动检查文件差异。"
          : !hasScan
            ? "点击扫描检查，确认本地文件状态。"
            : stats.errors
              ? "在“检查异常”中查看原因，处理后可重新检查或重试。"
              : stats.needs
                ? `预计下载 ${formatBytes(stats.needsBytes)}，更新前会显示文件列表。`
                : `已完成 ${stats.current} 个文件的版本比对 · ${formatClock(lastScannedAt!)}`;
  const filterByStatus = (value: StatusFilter) => {
    setStatusFilter(value);
    document
      .getElementById("files")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="brand">
          <div className="brand-mark">
            <Truck size={21} strokeWidth={2.4} />
            <span className="brand-pulse" />
          </div>
          <div>
            <strong>TMP Sync</strong>
            <span>CLIENT UPDATER</span>
          </div>
        </div>

        <div className="sidebar-label">工作台</div>
        <nav className="sidebar-nav" aria-label="主导航">
          <a
            href="#overview"
            className={activeSection === "overview" ? "active" : ""}
            aria-current={activeSection === "overview" ? "location" : undefined}
            onClick={() => setSidebarOpen(false)}
          >
            <Gauge size={18} />
            更新中心
            <span className="nav-pill">{stats.needs}</span>
          </a>
          <a
            href="#files"
            className={activeSection === "files" ? "active" : ""}
            aria-current={activeSection === "files" ? "location" : undefined}
            onClick={() => setSidebarOpen(false)}
          >
            <CloudDownload size={18} />
            文件清单
          </a>
          <a
            href="#activity"
            className={activeSection === "activity" ? "active" : ""}
            aria-current={activeSection === "activity" ? "location" : undefined}
            onClick={() => setSidebarOpen(false)}
          >
            <Activity size={18} />
            更新记录
          </a>
        </nav>

        <div className="sidebar-label">工具</div>
        <nav className="sidebar-nav" aria-label="工具导航">
          <button type="button" onClick={chooseDirectory} disabled={busy}>
            <FolderOpen size={18} />
            本地目录
          </button>
          <button type="button" onClick={() => setGuideOpen(true)}>
            <Info size={18} />
            关于与使用说明
          </button>
        </nav>

        <div className="sidebar-spacer" />
        <div className="api-mini-card">
          <div className="api-mini-head">
            <span className={`connection-dot ${sourceState}`} />
            <strong>
              {sourceState === "ready"
                ? "服务运行正常"
                : sourceState === "loading"
                  ? "正在连接"
                  : sourceState === "error"
                    ? "服务不可用"
                    : "等待连接"}
            </strong>
          </div>
          <span>
            {lastRefreshed
              ? `清单更新于 ${formatClock(lastRefreshed)}`
              : "TMP File Mirror"}
          </span>
        </div>
        <div className="sidebar-footer">
          <span>TMP SYNC</span>
          <span>v{APP_VERSION}</span>
        </div>
      </aside>

      {sidebarOpen && (
        <button
          className="sidebar-scrim"
          aria-label="关闭导航"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <main className="main">
        <header className="topbar">
          <button
            className="mobile-menu"
            onClick={() => setSidebarOpen(true)}
            aria-label="打开菜单"
          >
            <span />
            <span />
            <span />
          </button>
          <div className="breadcrumb">
            <span>TMP 更新工具</span>
            <span className="breadcrumb-separator">/</span>
            <strong>更新中心</strong>
          </div>
          <div className="topbar-actions">
            <button
              type="button"
              className="icon-button theme-toggle"
              onClick={() => {
                const next = theme === "light" ? "dark" : "light";
                setTheme(next);
                showNotice(
                  next === "dark" ? "已切换至深色模式" : "已切换至浅色模式",
                );
              }}
              title={theme === "light" ? "切换深色模式" : "切换浅色模式"}
              aria-label={theme === "light" ? "切换深色模式" : "切换浅色模式"}
              aria-pressed={theme === "dark"}
            >
              {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
            </button>
            <button
              type="button"
              className="directory-button"
              onClick={isDesktop ? requestReconnect : chooseDirectory}
              disabled={busy}
            >
              {isDesktop ? <ScanSearch size={17} /> : <FolderOpen size={17} />}
              <span>
                {isDesktop && hasDirectory ? "TruckersMP" : directoryName}
              </span>
              <ChevronDown size={14} />
            </button>
          </div>
        </header>

        <div className="content">
          <section className="page-heading" id="overview">
            <div>
              <div className="eyebrow">
                <span className="eyebrow-dot" />
                TRUCKERSMP CLIENT
              </div>
              <h1>
                TMP更新工具
              </h1>
              <p>
                {isDesktop
                  ? "自动检测 TruckersMP、扫描本地差异并安全更新。"
                  : "扫描本地文件差异，安全下载并校验 TMP 更新。"}
              </p>
            </div>
            <div className="heading-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => refreshSource()}
                disabled={busy}
              >
                <RefreshCw
                  size={16}
                  className={
                    sourceState === "loading" || isScanning ? "spin" : ""
                  }
                />
                {isScanning
                  ? "正在检查"
                  : sourceState === "loading"
                    ? "正在连接"
                    : "检查更新"}
              </button>
              <button
                type="button"
                className="button primary"
                onClick={() =>
                  !hasDirectory
                    ? isDesktop
                      ? requestReconnect()
                      : chooseDirectory()
                    : requestBatchUpdate()
                }
                disabled={
                  !items.length || busy || sourceState !== "ready" || isCurrent
                }
              >
                {busy ? (
                  <Loader2 size={17} className="spin" />
                ) : isCurrent ? (
                  <CheckCircle2 size={17} />
                ) : (
                  <Sparkles size={17} />
                )}
                {isScanning
                  ? "正在扫描"
                  : isUpdating
                    ? "正在更新"
                    : !hasDirectory
                      ? "连接客户端"
                      : !hasScan
                        ? "扫描检查"
                        : isCurrent
                          ? "已是最新"
                          : "智能更新"}
                {stats.needs > 0 && (
                  <span className="button-count">{stats.needs}</span>
                )}
              </button>
            </div>
          </section>

          {notice && (
            <div className="toast" role="status">
              <Info size={17} />
              {notice}
            </div>
          )}

          {sourceState === "error" && (
            <div className="error-banner">
              <AlertCircle size={18} />
              <div>
                <strong>无法获取远端文件清单</strong>
                <span>{sourceError}</span>
              </div>
              <button
                type="button"
                onClick={() => refreshSource()}
                disabled={busy}
              >
                重试
              </button>
            </div>
          )}

          <section className="workspace-grid">
            <div className="directory-card">
              <div className="directory-card-top">
                <div className="drive-icon">
                  <HardDrive size={23} />
                </div>
                <div className="directory-copy">
                  <span>
                    {isDesktop
                      ? installationSource === "auto"
                        ? "已自动检测到 TruckersMP"
                        : "TruckersMP 客户端目录"
                      : "本地客户端目录"}
                  </span>
                  <strong title={installPath || directoryName}>
                    {isDesktop
                      ? hasDirectory
                        ? "TruckersMP"
                        : "未检测到客户端"
                      : directoryName}
                  </strong>
                </div>
                <span
                  className={`permission-badge ${directoryNeedsPermission ? "warning" : hasDirectory ? "granted" : ""}`}
                >
                  <ShieldCheck size={13} />
                  {directoryNeedsPermission
                    ? "需要授权"
                    : hasDirectory
                      ? isDesktop
                        ? "已连接"
                        : "读写已授权"
                      : "未选择"}
                </span>
              </div>
              <div className="directory-path">
                <span className="path-root">安装目录</span>
                <span className="path-rule" />
                <span title={isDesktop ? installPath : undefined}>
                  {hasDirectory
                    ? isDesktop
                      ? installPath
                      : "文件将按原始相对路径写入"
                    : isDesktop
                      ? "尚未找到安装目录，可重新检测或手动选择"
                      : "选择包含 TMP 客户端的文件夹"}
                </span>
              </div>
              <div className="directory-actions">
                <button
                  type="button"
                  onClick={
                    isDesktop
                      ? requestReconnect
                      : directoryNeedsPermission
                        ? requestReconnect
                        : chooseDirectory
                  }
                  disabled={busy}
                >
                  {isDesktop ? (
                    <ScanSearch size={15} />
                  ) : (
                    <FolderOpen size={15} />
                  )}
                  {isDesktop
                    ? hasDirectory
                      ? "重新检测"
                      : "检测客户端"
                    : directoryNeedsPermission
                      ? "重新授权"
                      : hasDirectory
                        ? "更换目录"
                        : "选择目录"}
                </button>
                {isDesktop && (
                  <button
                    type="button"
                    className={`auto-detect-toggle ${autoDetect ? "active" : ""}`}
                    role="switch"
                    aria-checked={autoDetect}
                    aria-label="定时自动检测"
                    title={
                      lastDetectedAt
                        ? `上次检测 ${formatClock(lastDetectedAt)}`
                        : "每 5 分钟获取最新清单并检查文件"
                    }
                    onClick={() => {
                      setAutoDetect((value) => !value);
                      showNotice(
                        autoDetect
                          ? "已关闭定时自动检测"
                          : "已开启每 5 分钟自动检测",
                      );
                    }}
                    disabled={isUpdating}
                  >
                    <span className="auto-detect-dot" />
                    {autoDetect ? "每 5 分钟自动检查" : "自动检查已关闭"}
                  </button>
                )}
                {isDesktop && (
                  <button
                    type="button"
                    className={`auto-detect-toggle ${backgroundMode ? "active" : ""}`}
                    role="switch"
                    aria-checked={backgroundMode}
                    aria-label="关闭窗口后驻留托盘"
                    title="关闭窗口后继续检测，双击托盘图标可打开；托盘菜单可退出"
                    onClick={async () => {
                      try {
                        const result = await window.tmpDesktop!.setBackgroundMode(!backgroundMode);
                        setBackgroundMode(result.backgroundMode);
                        showNotice(result.backgroundMode ? "已开启托盘驻留" : "已关闭托盘驻留");
                      } catch (error) {
                        showNotice(`托盘设置失败：${(error as Error).message}`);
                      }
                    }}
                  >
                    <span className="auto-detect-dot" />
                    {backgroundMode ? "关闭窗口后驻留托盘" : "关闭窗口时退出"}
                  </button>
                )}
                {(hasDirectory || isDesktop) && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      isDesktop ? chooseDirectory() : requestReconnect()
                    }
                    disabled={busy}
                  >
                    {isDesktop ? (
                      <FolderOpen size={14} />
                    ) : (
                      <RotateCcw
                        size={14}
                        className={isScanning ? "spin" : ""}
                      />
                    )}
                    {isDesktop ? "手动选择" : "重新扫描"}
                  </button>
                )}
              </div>
              <div
                className={`directory-health ${busy ? "working" : stats.errors ? "error" : isCurrent ? "current" : stats.needs ? "pending" : ""}`}
                role="status"
              >
                <div className="health-symbol">
                  {busy ? (
                    <Loader2 size={20} className="spin" />
                  ) : isCurrent ? (
                    <CheckCircle2 size={20} />
                  ) : stats.errors ? (
                    <AlertCircle size={20} />
                  ) : (
                    <ScanSearch size={20} />
                  )}
                </div>
                <div className="health-copy">
                  <strong>{healthTitle}</strong>
                  <span>{healthDescription}</span>
                </div>
                {!busy && hasScan && stats.needs > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      filterByStatus(stats.errors ? "error" : "needs")
                    }
                  >
                    查看文件 <ArrowRight size={16} />
                  </button>
                )}
                {isUpdating && updateProgress && (
                  <strong className="health-percent">{updatePercent}%</strong>
                )}
              </div>
              {isUpdating && updateProgress && (
                <div
                  className="health-progress"
                  role="progressbar"
                  aria-label="更新进度"
                  aria-valuenow={updatePercent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <span style={{ width: `${updatePercent}%` }} />
                </div>
              )}
            </div>
          </section>

          <section className="stats-grid" aria-label="更新统计">
            <button
              type="button"
              className={`stat-card highlight ${effectiveStatusFilter === "needs" ? "selected" : ""}`}
              onClick={() => filterByStatus("needs")}
              aria-pressed={effectiveStatusFilter === "needs"}
            >
              <div className="stat-icon">
                <Zap size={19} />
              </div>
              <div>
                <span>待更新</span>
                <strong>{hasScan ? stats.needs : "—"}</strong>
              </div>
              <small>
                {hasScan ? formatBytes(stats.needsBytes) : "等待检查"}
              </small>
            </button>
            <button
              type="button"
              className={`stat-card ${effectiveStatusFilter === "current" ? "selected" : ""}`}
              onClick={() => filterByStatus("current")}
              aria-pressed={effectiveStatusFilter === "current"}
            >
              <div className="stat-icon green">
                <CheckCircle2 size={19} />
              </div>
              <div>
                <span>已是最新</span>
                <strong>{hasScan ? stats.current : "—"}</strong>
              </div>
              <small>
                {hasScan && items.length
                  ? `${Math.round((stats.current / items.length) * 100)}%`
                  : "等待检查"}
              </small>
            </button>
            <button
              type="button"
              className="stat-card"
              onClick={() => filterByStatus("all")}
            >
              <div className="stat-icon blue">
                <CloudDownload size={19} />
              </div>
              <div>
                <span>客户端文件</span>
                <strong>{items.length}</strong>
              </div>
              <small>{formatBytes(stats.totalBytes)}</small>
            </button>
            <button
              type="button"
              className={`stat-card ${effectiveStatusFilter === "error" ? "selected" : ""}`}
              onClick={() => filterByStatus("error")}
              aria-pressed={effectiveStatusFilter === "error"}
            >
              <div className="stat-icon neutral">
                <ShieldCheck size={19} />
              </div>
              <div>
                <span>检查异常</span>
                <strong>{hasScan ? stats.errors : "—"}</strong>
              </div>
              <small>
                {!hasScan ? "等待检查" : stats.errors ? "点击查看" : "无异常"}
              </small>
            </button>
          </section>

          <section className="files-section" id="files">
            <div className="section-heading">
              <div>
                <h2>文件清单</h2>
                <p>
                  {isScanning
                    ? "正在比对文件大小与 MD5"
                    : statusFilter === null && hasScan
                      ? stats.needs
                        ? `已自动显示 ${stats.needs} 个待更新文件，可切换查看全部`
                        : "全部文件已是最新，显示完整清单"
                      : "支持按类型和状态筛选文件"}
                </p>
              </div>
              {isScanning && (
                <div className="scan-progress">
                  <div>
                    <span>本地扫描</span>
                    <strong>
                      {scanProgress.done} / {scanProgress.total}
                    </strong>
                  </div>
                  <div className="mini-progress">
                    <span
                      style={{
                        width: `${scanProgress.total ? (scanProgress.done / scanProgress.total) * 100 : 0}%`,
                      }}
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="file-toolbar">
              <div className="type-tabs">
                {(
                  [
                    ["all", "全部"],
                    ["system", "系统"],
                    ["ets2", "欧卡"],
                    ["ats", "美卡"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={typeFilter === value ? "active" : ""}
                    aria-pressed={typeFilter === value}
                    onClick={() => setTypeFilter(value)}
                  >
                    {label}
                    <span>{filterCounts[value]}</span>
                  </button>
                ))}
              </div>
              <label className="search-field">
                <Search size={16} />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="搜索文件路径"
                  aria-label="搜索文件路径"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch("")}
                    aria-label="清除搜索"
                  >
                    <X size={14} />
                  </button>
                )}
              </label>
            </div>

            <div className="file-view-options">
              <div
                className="status-filters"
                role="group"
                aria-label="按文件状态筛选"
              >
                {(
                  [
                    ["all", "全部状态", items.length],
                    ["needs", "待更新", stats.needs],
                    ["current", "已是最新", stats.current],
                    ["error", "检查异常", stats.errors],
                  ] as const
                ).map(([value, label, count]) => (
                  <button
                    key={value}
                    type="button"
                    className={effectiveStatusFilter === value ? "active" : ""}
                    aria-pressed={effectiveStatusFilter === value}
                    onClick={() => setStatusFilter(value)}
                  >
                    {label}
                    <span>{value === "all" || hasScan ? count : "—"}</span>
                  </button>
                ))}
              </div>
              <span className="file-order-note">待处理优先</span>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="checkbox-cell">
                      <label className="custom-checkbox">
                        <input
                          type="checkbox"
                          checked={allVisibleSelected}
                          onChange={toggleAllVisible}
                          disabled={!visibleActionable.length || busy}
                          aria-label="全选当前可更新文件"
                        />
                        <span>
                          <Check size={12} />
                        </span>
                      </label>
                    </th>
                    <th>文件路径</th>
                    <th>类型</th>
                    <th>大小</th>
                    <th>状态</th>
                    <th className="align-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredItems.map((item) => {
                    const actionable = isActionable(item);
                    const isBusy = [
                      "downloading",
                      "verifying",
                      "installing",
                      "queued",
                    ].includes(item.state);
                    return (
                      <tr
                        key={item.filePath}
                        className={actionable ? "needs-update" : ""}
                      >
                        <td className="checkbox-cell">
                          <label className="custom-checkbox">
                            <input
                              type="checkbox"
                              checked={selected.has(item.filePath)}
                              onChange={() => toggleSelected(item.filePath)}
                              disabled={!actionable || busy}
                              aria-label={`选择 ${item.filePath}`}
                            />
                            <span>
                              <Check size={12} />
                            </span>
                          </label>
                        </td>
                        <td>
                          <div className="file-name-cell">
                            <div
                              className={`file-type-icon ${typeAccent(item.type)}`}
                            >
                              <span>
                                {fileBaseName(item.filePath)
                                  .split(".")
                                  .at(-1)
                                  ?.toUpperCase()
                                  .slice(0, 3) || "FILE"}
                              </span>
                            </div>
                            <div className="file-path">
                              <strong title={item.filePath}>
                                {fileBaseName(item.filePath)}
                              </strong>
                              <span title={item.filePath}>
                                /{parentPath(item.filePath) || "客户端根目录"}
                              </span>
                              {item.state === "error" && item.error && (
                                <small
                                  className="file-error"
                                  title={item.error}
                                >
                                  {item.error}
                                </small>
                              )}
                            </div>
                          </div>
                        </td>
                        <td>
                          <span
                            className={`type-badge ${typeAccent(item.type)}`}
                          >
                            {item.typeName}
                          </span>
                        </td>
                        <td>
                          <div className="size-cell">
                            <span>{formatBytes(item.fileSize)}</span>
                            {item.localSize !== undefined &&
                              item.localSize !== item.fileSize && (
                                <small>
                                  本地 {formatBytes(item.localSize)}
                                </small>
                              )}
                          </div>
                        </td>
                        <td>
                          <StatusBadge item={item} />
                          {item.state === "downloading" && item.speed ? (
                            <small className="speed-label">
                              {formatBytes(item.speed)}/s
                            </small>
                          ) : null}
                        </td>
                        <td className="align-right">
                          <div className="file-actions">
                            <button
                              type="button"
                              className="file-detail-button"
                              aria-label={`文件详情 ${item.filePath}`}
                              title="文件详情"
                              onClick={() => setDetailPath(item.filePath)}
                            >
                              <Info size={15} />
                            </button>
                            {actionable ? (
                              <button
                                type="button"
                                className="row-action"
                                onClick={() =>
                                  requestBatchUpdate([item.filePath])
                                }
                                disabled={busy}
                              >
                                {item.state === "error" ? (
                                  <RotateCcw size={13} />
                                ) : (
                                  <Download size={13} />
                                )}
                                {item.state === "error" ? "重试" : "更新"}
                              </button>
                            ) : item.state === "idle" ? (
                              <span className="row-idle">待检查</span>
                            ) : isBusy ? (
                              <span className="row-progress">
                                {item.transferred
                                  ? `${Math.round((item.transferred / item.fileSize) * 100)}%`
                                  : "…"}
                              </span>
                            ) : (
                              <span className="row-idle">
                                {item.state === "checking" ? (
                                  "检查中"
                                ) : (
                                  <>
                                    <Check size={13} /> 已同步
                                  </>
                                )}
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {!filteredItems.length && (
                <div className="table-empty">
                  {sourceState === "loading" ? (
                    <>
                      <Loader2 size={26} className="spin" />
                      <strong>正在获取文件清单</strong>
                      <span>正在连接更新服务，请稍候。</span>
                    </>
                  ) : (
                    <>
                      <Search size={25} />
                      <strong>
                        {effectiveStatusFilter === "needs" &&
                        hasScan &&
                        !stats.needs
                          ? "所有文件均已是最新"
                          : effectiveStatusFilter === "error" &&
                              hasScan &&
                              !stats.errors
                            ? "没有检查异常"
                            : "没有匹配的文件"}
                      </strong>
                      <span>
                        {!hasScan && effectiveStatusFilter !== "all"
                          ? "完成客户端检查后，这里将显示对应状态的文件。"
                          : "可以切换状态、类型或清除搜索条件。"}
                      </span>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => {
                          setSearch("");
                          setStatusFilter("all");
                          setTypeFilter("all");
                        }}
                      >
                        显示全部文件
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="table-footer">
              <span>
                显示 {filteredItems.length} / {items.length} 个文件
              </span>
              <div>
                {isUpdating && updateProgress ? (
                  <>
                    <span className="footer-current">
                      {isCancelling
                        ? "正在停止…"
                        : `已完成 ${updateProgress.completed}/${updateProgress.total}`}
                    </span>
                    <button
                      type="button"
                      className="stop-button"
                      onClick={cancelUpdate}
                      disabled={isCancelling}
                    >
                      <Square size={12} fill="currentColor" />
                      停止
                    </button>
                  </>
                ) : (
                  <>
                    {items.some((item) => item.state === "error") && (
                      <button
                        type="button"
                        className="footer-update"
                        disabled={busy}
                        onClick={() => requestBatchUpdate(items.filter((item) => item.state === "error").map((item) => item.filePath))}
                      >
                        <RotateCcw size={14} />
                        重试失败文件
                      </button>
                    )}
                    <span>
                      已选择 {selectedItems.length} 个文件
                      {selectedItems.length > 0
                        ? ` · ${formatBytes(selectedBytes)}`
                        : ""}
                    </span>
                    <button
                      type="button"
                      className="footer-update"
                      disabled={!selectedItems.length || busy}
                      onClick={() =>
                        requestBatchUpdate(
                          selectedItems.map((item) => item.filePath),
                        )
                      }
                    >
                      <Download size={14} />
                      更新所选
                    </button>
                  </>
                )}
              </div>
            </div>
          </section>

          <section className="activity-section" id="activity">
            <div className="activity-head">
              <div>
                <h2>更新记录</h2>
                <p>保留本次运行的最近操作</p>
              </div>
              <div className="activity-actions">
                  <button type="button" onClick={() => void exportDiagnostics()} title="导出本次运行的文件状态和错误记录">
                    <FileDown size={14} /> 导出日志
                  </button>
                  {activities.length > 8 && (
                    <button
                      type="button"
                      onClick={() => setActivityExpanded((value) => !value)}
                    >
                      {activityExpanded
                        ? "收起记录"
                        : `查看全部 ${activities.length} 条`}
                    </button>
                  )}
                  {activities.length > 0 && <button
                    type="button"
                    onClick={() => {
                      setActivities([]);
                      setActivityExpanded(false);
                    }}
                  >
                    清空
                  </button>}
                </div>
            </div>
            {activities.length === 0 ? (
              <EmptyActivity />
            ) : (
              <div className="activity-list">
                {(activityExpanded ? activities : activities.slice(0, 8)).map(
                  (entry) => (
                    <div className="activity-entry" key={entry.id}>
                      <span className={`activity-dot ${entry.level}`} />
                      <span title={entry.message}>{entry.message}</span>
                      <time>{entry.time}</time>
                    </div>
                  ),
                )}
              </div>
            )}
          </section>
        </div>
      </main>

      {isUpdating && updateProgress && (
        <div className="floating-progress">
          <div className="floating-icon">
            <ArrowDownToLine size={20} />
          </div>
          <div className="floating-copy">
            <div>
              <strong>
                {updateProgress.currentNames[0]
                  ? fileBaseName(updateProgress.currentNames[0])
                  : "正在准备文件"}
              </strong>
              <span>{updatePercent}%</span>
            </div>
            <div className="floating-bar">
              <span style={{ width: `${updatePercent}%` }} />
            </div>
            <small>
              {updateProgress.phase === "retrying" ? "自动重试" : updateProgress.phase === "verifying" ? "校验" : updateProgress.phase === "installing" ? "安装" : "下载"}
              {" · "}{formatBytes(updateProgress.bytesDone)} / {formatBytes(updateProgress.bytesTotal)}
              {" · "}{formatBytes(updateProgress.speed || 0)}/s
              {" · "}剩余 {formatEta(updateProgress.etaSeconds)}
            </small>
          </div>
          <button
            type="button"
            onClick={cancelUpdate}
            aria-label="停止更新"
            disabled={isCancelling}
          >
            <Square size={13} fill="currentColor" />
          </button>
        </div>
      )}

      {detailItem && (
        <div className="modal-layer">
          <button
            className="modal-backdrop"
            onClick={() => setDetailPath(null)}
            aria-label="关闭文件详情"
          />
          <div
            className="modal detail-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="file-detail-title"
          >
            <div className="modal-head">
              <div className="modal-icon">
                <Info size={21} />
              </div>
              <div>
                <h3 id="file-detail-title">文件详情</h3>
                <p>{fileBaseName(detailItem.filePath)}</p>
              </div>
              <button
                type="button"
                className="modal-close"
                onClick={() => setDetailPath(null)}
                aria-label="关闭"
              >
                <X size={18} />
              </button>
            </div>
            <StatusBadge item={detailItem} />
            {detailItem.error && (
              <div className="detail-error">
                <AlertCircle size={17} />
                <span>{detailItem.error}</span>
              </div>
            )}
            <dl className="file-details">
              <div>
                <dt>文件路径</dt>
                <dd>{detailItem.filePath}</dd>
              </div>
              <div>
                <dt>文件类型</dt>
                <dd>{detailItem.typeName}</dd>
              </div>
              <div>
                <dt>目标大小</dt>
                <dd>{formatBytes(detailItem.fileSize)}</dd>
              </div>
              <div>
                <dt>本地大小</dt>
                <dd>
                  {detailItem.state === "missing"
                    ? "文件不存在"
                    : detailItem.localSize !== undefined
                      ? formatBytes(detailItem.localSize)
                      : "尚未读取"}
                </dd>
              </div>
              <div>
                <dt>目标 MD5</dt>
                <dd className="checksum">{detailItem.md5}</dd>
              </div>
              <div>
                <dt>本地 MD5</dt>
                <dd className="checksum">
                  {detailItem.localMd5 ||
                    (detailItem.localSize !== undefined &&
                    detailItem.localSize !== detailItem.fileSize
                      ? "大小不同，已跳过计算"
                      : "尚未计算")}
                </dd>
              </div>
              <div>
                <dt>清单更新时间</dt>
                <dd>{detailItem.updateTime || "未提供"}</dd>
              </div>
            </dl>
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setDetailPath(null)}
              >
                关闭
              </button>
              {isActionable(detailItem) && (
                <button
                  type="button"
                  className="button primary"
                  disabled={busy}
                  onClick={() => {
                    setDetailPath(null);
                    void requestBatchUpdate([detailItem.filePath]);
                  }}
                >
                  <Download size={16} />
                  {detailItem.state === "error" ? "重试更新" : "更新此文件"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {guideOpen && (
        <div
          className="modal-layer"
          role="dialog"
          aria-modal="true"
          aria-label="关于与使用说明"
        >
          <button
            className="modal-backdrop"
            onClick={() => setGuideOpen(false)}
            aria-label="关闭"
          />
          <div className="modal guide-modal">
            <div className="modal-head">
              <div className="modal-icon">
                <CircleHelp size={20} />
              </div>
              <div>
                <h3>关于 TMP 更新工具</h3>
                <p>自动检测、校验并更新 TruckersMP 客户端文件</p>
              </div>
              <button
                type="button"
                className="modal-close"
                onClick={() => setGuideOpen(false)}
              >
                <X size={18} />
              </button>
            </div>
            <div className="about-summary">
              <div>
                <strong>TMP 更新工具</strong>
                <span>v{APP_VERSION}</span>
              </div>
              <p>作者：BGYdook</p>
              <div className="about-links">
                <button type="button" onClick={() => void openRepository(GITHUB_REPO_URL)}>
                  <Github size={15} />
                  GitHub 仓库
                  <ExternalLink size={13} />
                </button>
                <button type="button" onClick={() => void openRepository(CNB_REPO_URL)}>
                  <CloudDownload size={15} />
                  CNB 仓库
                  <ExternalLink size={13} />
                </button>
              </div>
              <div className="app-update-row">
                <div>
                  <strong>软件更新</strong>
                  <span>
                    {appUpdate.message || "更新源：CNB Release"}
                  </span>
                </div>
                {appUpdate.status === "available" ? (
                  <button type="button" className="button primary" onClick={() => void installAppUpdate()}>
                    <Download size={14} />
                    安装 v{appUpdate.latestVersion}
                  </button>
                ) : (
                  <button type="button" className="button secondary" onClick={() => void checkAppUpdate()} disabled={appUpdate.status === "checking" || appUpdate.status === "installing"}>
                    <RefreshCw size={14} className={appUpdate.status === "checking" ? "spin" : undefined} />
                    {appUpdate.status === "checking" ? "检查中" : "检查更新"}
                  </button>
                )}
              </div>
              {appUpdate.releaseUrl && appUpdate.status === "available" && (
                <button type="button" className="docs-link" onClick={() => void openRepository(appUpdate.releaseUrl!)}>
                  查看 CNB 发布页 <ExternalLink size={13} />
                </button>
              )}
            </div>
            <div className="guide-divider"><span>使用流程</span></div>
            <div className="guide-steps">
              <div>
                <span>01</span>
                <div>
                  <strong>
                    {isDesktop ? "自动定位客户端" : "选择客户端目录"}
                  </strong>
                  <p>
                    {isDesktop
                      ? "启动时自动读取 TruckersMP 的 launcher-options.json，并定位当前安装目录。"
                      : "请在文件选择器中授权 TMP 客户端所在目录，工具不会上传任何本地文件。"}
                  </p>
                </div>
              </div>
              <div>
                <span>02</span>
                <div>
                  <strong>检查文件差异</strong>
                  <p>
                    按文件大小和 MD5 与远端清单比对。相同大小的文件也会计算 MD5
                    确认。
                  </p>
                </div>
              </div>
              <div>
                <span>03</span>
                <div>
                  <strong>安全更新</strong>
                  <p>
                    下载到临时文件，校验 MD5
                    后才替换原文件；失败时尽量恢复原文件。
                  </p>
                </div>
              </div>
            </div>
            <div className="guide-note">
              <ShieldCheck size={17} />
              更新前请关闭欧卡 2 或美卡；TruckersMP 启动器可以保持打开。
            </div>
            <button
              type="button"
              className="button primary full"
              onClick={() => setGuideOpen(false)}
            >
              我知道了
            </button>
          </div>
        </div>
      )}

      {confirmState && (
        <div
          className="modal-layer"
          role="dialog"
          aria-modal="true"
          aria-label="确认更新"
        >
          <button
            className="modal-backdrop"
            onClick={() => setConfirmState(null)}
            aria-label="关闭"
          />
          <div className="modal confirm-modal">
            <div className="confirm-symbol">
              <CloudDownload size={25} />
            </div>
            <h3>准备更新 {confirmState.paths.length} 个文件</h3>
            <p className="confirm-description">
              将下载 {formatBytes(confirmState.bytes)}{" "}
              数据，并用校验通过的版本覆盖本地同名文件。
            </p>
            <div className="confirm-list">
              {items
                .filter((item) => confirmState.paths.includes(item.filePath))
                .map((item) => (
                  <div key={item.filePath}>
                    <span
                      className={`mini-file-mark ${typeAccent(item.type)}`}
                    />
                    <span>{item.filePath}</span>
                    <small>{formatBytes(item.fileSize)}</small>
                  </div>
                ))}
            </div>
            <div className="confirm-warning">
              <AlertCircle size={16} />
              更新期间请保持页面打开，并关闭正在占用客户端文件的程序。
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setConfirmState(null)}
              >
                稍后更新
              </button>
              <button
                type="button"
                className="button primary"
                onClick={() => runUpdate(confirmState.paths)}
              >
                <Zap size={16} />
                开始更新
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
