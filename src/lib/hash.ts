import SparkMD5 from "spark-md5";

export interface Md5Hasher {
  update(chunk: ArrayBuffer): void;
  digest(): string;
}

export function createMd5Hasher(): Md5Hasher {
  const hasher = new SparkMD5.ArrayBuffer();
  return {
    update: (chunk) => hasher.append(chunk),
    digest: () => hasher.end().toLowerCase(),
  };
}

export async function hashFile(file: File, signal?: AbortSignal): Promise<string> {
  const hasher = createMd5Hasher();
  const reader = file.stream().getReader();

  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("操作已取消", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      const copy = new Uint8Array(value.byteLength);
      copy.set(value);
      hasher.update(copy.buffer);
    }
    return hasher.digest();
  } finally {
    reader.releaseLock();
  }
}
