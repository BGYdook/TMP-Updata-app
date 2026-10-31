import { chromium } from "playwright-core";

const browser = await chromium.launch({
  headless: true,
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
});
const page = await browser.newPage();

try {
  await page.goto("http://127.0.0.1:5173/", { waitUntil: "networkidle" });
  const result = await page.evaluate(async () => {
    const api = await import("/src/lib/api.ts");
    const download = await import("/src/lib/download.ts");
    const hash = await import("/src/lib/hash.ts");
    const files = await api.fetchTmpFiles(api.DEFAULT_API_BASE);
    const target = files.find((file) => file.filePath === "/data/ats/client2.mp");
    if (!target) throw new Error("Smoke-test file is missing from the API");

    const storage = await navigator.storage.getDirectory();
    const testName = `tmp-sync-smoke-${Date.now()}`;
    const root = await storage.getDirectoryHandle(testName, { create: true });
    try {
      const data = await root.getDirectoryHandle("data", { create: true });
      const ats = await data.getDirectoryHandle("ats", { create: true });
      const existing = await ats.getFileHandle("client2.mp", { create: true });
      const existingWriter = await existing.createWritable();
      const originalBytes = new Uint8Array(target.fileSize).fill(65);
      await existingWriter.write(originalBytes);
      await existingWriter.close();

      let rejectedInvalidMd5 = false;
      try {
        await download.downloadAndInstall(
          root,
          { ...target, md5: "0".repeat(32) },
          api.buildDownloadUrl(api.DEFAULT_API_BASE, target),
          new AbortController().signal,
        );
      } catch (error) {
        rejectedInvalidMd5 = String(error).includes("MD5");
      }
      const afterFailure = new Uint8Array(await (await existing.getFile()).arrayBuffer());
      if (!rejectedInvalidMd5 || afterFailure.some((value) => value !== 65)) {
        throw new Error("Failed download did not preserve the original file");
      }

      await download.downloadAndInstall(
        root,
        target,
        api.buildDownloadUrl(api.DEFAULT_API_BASE, target),
        new AbortController().signal,
      );
      const installed = await (await ats.getFileHandle("client2.mp")).getFile();
      const md5 = await hash.hashFile(installed);
      const names = [];
      for await (const [name] of ats.entries()) names.push(name);
      return {
        path: target.filePath,
        expectedMd5: target.md5,
        actualMd5: md5,
        size: installed.size,
        expectedSize: target.fileSize,
        invalidMd5Rejected: rejectedInvalidMd5,
        originalPreservedOnFailure: true,
        leftoverFiles: names.filter((name) => name.includes(".tmpup.")),
      };
    } finally {
      await storage.removeEntry(testName, { recursive: true });
    }
  });

  if (
    result.actualMd5 !== result.expectedMd5 ||
    result.size !== result.expectedSize ||
    result.leftoverFiles.length > 0
  ) {
    throw new Error(`Smoke test failed: ${JSON.stringify(result)}`);
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
