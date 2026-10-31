import { normalizeRemotePath } from "./api";

export async function ensurePermission(
  handle: FileSystemDirectoryHandle,
  request = false,
): Promise<boolean> {
  const descriptor = { mode: "readwrite" as const };
  if (handle.queryPermission) {
    const state = await handle.queryPermission(descriptor);
    if (state === "granted") return true;
  }
  if (request && handle.requestPermission) {
    return (await handle.requestPermission(descriptor)) === "granted";
  }
  return false;
}

export async function resolveFileHandle(
  root: FileSystemDirectoryHandle,
  remotePath: string,
): Promise<FileSystemFileHandle | null> {
  const parts = normalizeRemotePath(remotePath).split("/");
  let directory = root;

  try {
    for (const part of parts.slice(0, -1)) {
      directory = await directory.getDirectoryHandle(part);
    }
    return await directory.getFileHandle(parts.at(-1)!);
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return null;
    throw error;
  }
}

export async function ensureParentDirectories(
  root: FileSystemDirectoryHandle,
  remotePath: string,
): Promise<FileSystemDirectoryHandle> {
  const parts = normalizeRemotePath(remotePath).split("/");
  let directory = root;
  for (const part of parts.slice(0, -1)) {
    directory = await directory.getDirectoryHandle(part, { create: true });
  }
  return directory;
}

export async function removeEntryIfExists(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  try {
    await directory.removeEntry(name);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
  }
}
