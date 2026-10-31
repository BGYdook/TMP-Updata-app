const DB_NAME = "tmp-sync-storage";
const DB_VERSION = 1;
const SETTINGS_STORE = "settings";
const FINGERPRINT_STORE = "fingerprints";

export interface FileRecord {
  size: number;
  lastModified: number;
  md5: string;
}

interface FingerprintRecord {
  directory: FileSystemDirectoryHandle;
  files: Record<string, FileRecord>;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE);
      }
      if (!db.objectStoreNames.contains(FINGERPRINT_STORE)) {
        db.createObjectStore(FINGERPRINT_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getValue<T>(storeName: string, key: string): Promise<T | undefined> {
  const db = await openDatabase();
  return new Promise<T | undefined>((resolve, reject) => {
    const request = db
      .transaction(storeName, "readonly")
      .objectStore(storeName)
      .get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  }).finally(() => db.close());
}

async function putValue(storeName: string, key: string, value: unknown): Promise<void> {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  }).finally(() => db.close());
}

export async function saveDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  await putValue(SETTINGS_STORE, "directoryHandle", handle);
}

export async function loadDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return (await getValue<FileSystemDirectoryHandle>(SETTINGS_STORE, "directoryHandle")) ?? null;
  } catch {
    return null;
  }
}

export async function loadFingerprints(
  directory: FileSystemDirectoryHandle,
): Promise<Record<string, FileRecord>> {
  try {
    const record = await getValue<FingerprintRecord>(FINGERPRINT_STORE, "active");
    if (!record?.directory || !(await directory.isSameEntry(record.directory))) return {};
    return record.files;
  } catch {
    return {};
  }
}

export async function saveFingerprints(
  directory: FileSystemDirectoryHandle,
  files: Record<string, FileRecord>,
): Promise<void> {
  try {
    await putValue(FINGERPRINT_STORE, "active", {
      directory,
      files,
    } satisfies FingerprintRecord);
  } catch {
    // A storage failure should not block synchronization.
  }
}

export function makeFileSignature(size: number, lastModified: number): string {
  return `${size}:${lastModified}`;
}
