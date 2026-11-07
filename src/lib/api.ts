import type { TmpApiResponse, TmpFile } from "../types";

export const DEFAULT_API_BASE = "https://tmplistoss.bgydook.cn";
export const BACKUP_API_BASE = "https://tmplistoss.lvyevtc.cn";
export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export async function fetchTmpFiles(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<TmpFile[]> {
  const base = normalizeBaseUrl(baseUrl);
  if (!/^https?:\/\//i.test(base)) {
    throw new Error("接口地址必须以 http:// 或 https:// 开头");
  }

  const response = await fetch(`${base}/api/tmp/files`, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
      : AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    if (response.status === 429) {
      throw new Error("请求过于频繁，请稍后再试");
    }
    if (response.status === 403) {
      throw new Error("当前 IP 受到访问限制");
    }
    throw new Error(`文件清单请求失败（HTTP ${response.status}）`);
  }

  const payload = (await response.json()) as TmpApiResponse;
  if (payload.code !== 200 || !Array.isArray(payload.data)) {
    throw new Error(payload.msg || "接口返回了无效的文件清单");
  }

  return deduplicateFiles(payload.data);
}

export async function selectFastestTmpBaseUrl(
  baseUrls: string[] = [DEFAULT_API_BASE, BACKUP_API_BASE],
): Promise<{ baseUrl: string; latencyMs: number }> {
  const controllers = baseUrls.map(() => new AbortController());
  try {
    return await Promise.any(
      baseUrls.map(async (baseUrl, index) => {
        const startedAt = performance.now();
        const files = await fetchTmpFiles(baseUrl, controllers[index].signal);
        if (!files.length) throw new Error("TMP 文件清单为空");
        return {
          baseUrl: normalizeBaseUrl(baseUrl),
          latencyMs: Math.round(performance.now() - startedAt),
        };
      }),
    );
  } finally {
    controllers.forEach((controller) => controller.abort());
  }
}

function deduplicateFiles(files: TmpFile[]): TmpFile[] {
  const unique = new Map<string, TmpFile>();
  for (const file of files) {
    if (
      file &&
      typeof file.filePath === "string" &&
      typeof file.md5 === "string" &&
      Number.isFinite(file.fileSize)
    ) {
      unique.set(normalizeRemotePath(file.filePath), file);
    }
  }
  return [...unique.values()].sort((a, b) =>
    a.filePath.localeCompare(b.filePath),
  );
}

export function normalizeRemotePath(filePath: string): string {
  const parts = filePath.replaceAll("\\", "/").split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error(`不安全的文件路径：${filePath}`);
  }
  return parts.join("/");
}

export function buildDownloadUrl(baseUrl: string, file: TmpFile): string {
  const base = normalizeBaseUrl(baseUrl);
  let url: URL;

  if (file.downloadUrl?.trim()) {
    url = new URL(file.downloadUrl, `${base}/`);
  } else {
    const encodedPath = normalizeRemotePath(file.filePath)
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    url = new URL(`/files/${encodedPath}`, `${base}/`);
  }

  // The API requires the MD5 version parameter for cache-safe downloads.
  if (!url.searchParams.get("v")) {
    url.searchParams.set("v", file.md5);
  }
  return url.toString();
}
