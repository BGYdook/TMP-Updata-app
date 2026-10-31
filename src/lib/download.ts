import type { TmpFile } from "../types";
import {
  ensureParentDirectories,
  removeEntryIfExists,
} from "./local-files";
import { createMd5Hasher } from "./hash";

export interface DownloadCallbacks {
  onProgress?: (transferred: number, total: number, bytesPerSecond: number) => void;
  onRetry?: (attempt: number, reason: string) => void;
  onVerifying?: () => void;
  onInstalling?: () => void;
}

function chunkBuffer(chunk: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(chunk.byteLength);
  copy.set(chunk);
  return copy.buffer;
}

async function copyFile(
  source: FileSystemFileHandle,
  destination: FileSystemFileHandle,
  signal: AbortSignal,
): Promise<void> {
  const file = await source.getFile();
  const reader = file.stream().getReader();
  const writer = await destination.createWritable();

  try {
    while (true) {
      if (signal.aborted) throw new DOMException("操作已取消", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      await writer.write(value);
    }
    await writer.close();
  } catch (error) {
    try {
      await writer.abort();
    } catch {
      // The original failure is more useful to the caller.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function downloadAndInstall(
  root: FileSystemDirectoryHandle,
  file: TmpFile,
  downloadUrl: string,
  signal: AbortSignal,
  callbacks: DownloadCallbacks = {},
): Promise<void> {
  const pathParts = file.filePath.replaceAll("\\", "/").split("/").filter(Boolean);
  const fileName = pathParts.at(-1)!;
  const parent = await ensureParentDirectories(root, file.filePath);
  const temporaryName = `.${fileName}.tmpup.part`;
  const backupName = `.${fileName}.tmpup.bak`;
  let temporaryHandle: FileSystemFileHandle;

  await removeEntryIfExists(parent, backupName);
  let backupCreated = false;
  let preserveBackup = false;
  const oldHandle = await parent.getFileHandle(fileName).catch((error: unknown) => {
    if (error instanceof DOMException && error.name === "NotFoundError") return null;
    throw error;
  });

  try {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
    temporaryHandle = await parent.getFileHandle(temporaryName, { create: true });
    callbacks.onProgress?.(0, file.fileSize, 0);
    const response = await fetch(downloadUrl, {
      headers: { Accept: "application/octet-stream" },
      cache: "no-cache",
      signal: AbortSignal.any([signal, AbortSignal.timeout(900_000)]),
    });

    if (!response.ok) {
      const failure = new Error(response.status === 404 ? "远端文件不存在，请刷新文件清单"
        : response.status === 429 ? "请求过于频繁，请稍后重试"
          : response.status === 403 ? "当前 IP 受到下载限制"
            : `下载失败（HTTP ${response.status}）`);
      (failure as Error & { retryable?: boolean }).retryable = response.status === 429 || response.status >= 500;
      throw failure;
    }
    if (!response.body) throw new Error("下载响应不包含文件内容");
    const total = Number(response.headers.get("content-length")) || file.fileSize;
    if (total > 400 * 1024 * 1024) throw new Error("文件超过 400 MB 安全上限");
    const reader = response.body.getReader();
    const writer = await temporaryHandle.createWritable();
    const hasher = createMd5Hasher();
    let transferred = 0;
    let lastTime = performance.now();
    let lastBytes = 0;
    let speed = 0;

    try {
      while (true) {
        if (signal.aborted) throw new DOMException("操作已取消", "AbortError");
        const { done, value } = await reader.read();
        if (done) break;
        const buffer = chunkBuffer(value);
        if (transferred + value.byteLength > 400 * 1024 * 1024) throw new Error("文件超过 400 MB 安全上限");
        hasher.update(buffer);
        await writer.write(value);
        transferred += value.byteLength;

        const now = performance.now();
        if (now - lastTime > 120) {
          speed = ((transferred - lastBytes) * 1000) / (now - lastTime);
          lastTime = now;
          lastBytes = transferred;
          callbacks.onProgress?.(transferred, total, speed);
        }
      }
      await writer.close();
    } catch (error) {
      try {
        await writer.abort();
      } catch {
        // Ignore cleanup failures and preserve the root error.
      }
      throw error;
    } finally {
      reader.releaseLock();
    }

    callbacks.onProgress?.(transferred, total, speed);
    if (transferred !== file.fileSize) throw new Error(`文件长度不一致：期望 ${file.fileSize} 字节，实际 ${transferred} 字节`);
    callbacks.onVerifying?.();
    const actualMd5 = hasher.digest();
    if (actualMd5.toLowerCase() !== file.md5.toLowerCase()) {
      throw new Error("MD5 校验失败，文件可能不完整");
    }
    break;
    } catch (error) {
      if (signal.aborted) throw new DOMException("操作已取消", "AbortError");
      const failure = error as Error & { retryable?: boolean };
      if (attempt === 3 || ["NotAllowedError", "QuotaExceededError", "NoModificationAllowedError"].includes(failure.name) || failure.retryable === false || failure.message.includes("安全上限")) throw error;
      await removeEntryIfExists(parent, temporaryName).catch(() => undefined);
      callbacks.onRetry?.(attempt + 1, failure.message);
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, attempt === 1 ? 1000 : 2500);
        const abort = () => { window.clearTimeout(timer); reject(new DOMException("操作已取消", "AbortError")); };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    }
    }

    callbacks.onInstalling?.();
    if (oldHandle) {
      const backupHandle = await parent.getFileHandle(backupName, { create: true });
      await copyFile(oldHandle, backupHandle, signal);
      backupCreated = true;
    }

    try {
      const destinationHandle = await parent.getFileHandle(fileName, { create: true });
      await copyFile(temporaryHandle!, destinationHandle, signal);
    } catch (error) {
      if (backupCreated) {
        try {
          const backupHandle = await parent.getFileHandle(backupName);
          const destinationHandle = await parent.getFileHandle(fileName, { create: true });
          await copyFile(
            backupHandle,
            destinationHandle,
            new AbortController().signal,
          );
        } catch {
          preserveBackup = true;
          throw new Error(`${(error as Error).message}；原文件恢复失败，备份位于 ${backupName}`);
        }
      }
      throw error;
    }

    await removeEntryIfExists(parent, backupName);
    await removeEntryIfExists(parent, temporaryName);
  } catch (error) {
    await removeEntryIfExists(parent, temporaryName).catch(() => undefined);
    if (!preserveBackup) {
      await removeEntryIfExists(parent, backupName).catch(() => undefined);
    }
    throw error;
  }
}
