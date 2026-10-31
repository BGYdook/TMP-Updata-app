import { chromium } from "playwright-core";

const browser = await chromium.launch({
  headless: true,
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

try {
  await page.goto("http://127.0.0.1:5173/", { waitUntil: "networkidle" });
  const { testName, retryUrl } = await page.evaluate(async () => {
    const api = await import("/src/lib/api.ts");
    const download = await import("/src/lib/download.ts");
    const files = await api.fetchTmpFiles(api.DEFAULT_API_BASE);
    const currentFile = files.find(
      (file) => file.filePath === "/data/ets2/client2.mp",
    );
    const outdatedFile = files.find(
      (file) => file.filePath === "/data/ats/client2.mp",
    );
    if (!currentFile || !outdatedFile)
      throw new Error("Smoke-test files are missing");

    const storage = await navigator.storage.getDirectory();
    const testName = `tmp-sync-ui-${Date.now()}`;
    const root = await storage.getDirectoryHandle(testName, { create: true });
    await download.downloadAndInstall(
      root,
      currentFile,
      api.buildDownloadUrl(api.DEFAULT_API_BASE, currentFile),
      new AbortController().signal,
    );
    const ats = await (
      await root.getDirectoryHandle("data")
    ).getDirectoryHandle("ats", { create: true });
    const outdated = await ats.getFileHandle("client2.mp", { create: true });
    const writer = await outdated.createWritable();
    await writer.write(new Uint8Array(outdatedFile.fileSize));
    await writer.close();

    Object.defineProperty(root, "queryPermission", {
      value: async () => "granted",
    });
    Object.defineProperty(root, "requestPermission", {
      value: async () => "granted",
    });
    window.showDirectoryPicker = async () => root;
    return { testName, retryUrl: api.buildDownloadUrl(api.DEFAULT_API_BASE, outdatedFile) };
  });

  let retryRequests = 0;
  await page.route(retryUrl, (route) => {
    retryRequests += 1;
    if (retryRequests === 1) return route.fulfill({ status: 503, body: "temporary failure" });
    return route.continue();
  });

  await page.getByRole("button", { name: "选择目录" }).first().click();
  await page
    .getByText(/扫描完成：/)
    .waitFor({ state: "visible", timeout: 15_000 });
  if (await page.locator(".status-badge.current").count()) {
    throw new Error(
      "The automatic list must hide current files when updates exist",
    );
  }
  await page.getByRole("button", { name: /全部状态/ }).click();

  const result = await page.evaluate(() => ({
    current: document.querySelectorAll(".status-badge.current").length,
    outdated: document.querySelectorAll(".status-badge.outdated").length,
    missing: document.querySelectorAll(".status-badge.missing").length,
    pending: document.querySelectorAll(".status-badge.idle").length,
    updateButton: document.querySelector(".page-heading .button.primary")
      ?.textContent,
  }));
  if (result.current < 1 || result.outdated < 1 || result.missing < 1) {
    throw new Error(`Unexpected scan state: ${JSON.stringify(result)}`);
  }

  await page.screenshot({ path: "artifacts/scan-result.png" });

  await page.getByPlaceholder("搜索文件路径").fill("client2");
  const outdatedRow = page.locator("tbody tr").filter({ hasText: "/data/ats" });
  await outdatedRow.getByRole("button", { name: "更新" }).click();
  await page.getByText("准备更新 1 个文件").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "开始更新" }).click();
  await page
    .getByText(/更新完成：成功 1\/1/)
    .waitFor({ state: "visible", timeout: 15_000 });
  if (retryRequests !== 2) throw new Error(`Expected one browser retry, received ${retryRequests} requests`);
  await page.getByRole("button", { name: /全部状态/ }).click();
  await page.screenshot({ path: "artifacts/update-result.png" });
  await page.getByPlaceholder("搜索文件路径").fill("");

  await page.getByRole("button", { name: /智能更新/ }).click();
  await page.getByText("准备更新 174 个文件").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "稍后更新" }).click();

  await page.getByPlaceholder("搜索文件路径").fill("client2");
  const filteredRows = await page.locator("tbody tr").count();
  if (filteredRows !== 2) {
    throw new Error(`Search filter expected 2 rows, received ${filteredRows}`);
  }
  await page.getByPlaceholder("搜索文件路径").fill("");

  const completed = await page.locator(".status-badge.current").count();
  console.log(JSON.stringify({ testName, ...result, completed, retryRequests }, null, 2));
} finally {
  await browser.close();
}
