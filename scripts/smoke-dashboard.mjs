import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const files = [
  ["/data/current.bin", "current"],
  ["/data/outdated.bin", "outdated"],
  ["/data/missing.bin", "missing"],
  ["/data/locked.bin", "error"],
].map(([filePath, state]) => ({
  filePath,
  state,
  type: 1,
  typeName: "系统",
  fileSize: 1024,
  md5: "0123456789abcdef0123456789abcdef",
  downloadUrl: "",
  updateTime: "2026-10-31 12:00:00",
  error:
    state === "error" ? "文件被其他程序占用，请关闭客户端后重试" : undefined,
}));

const browser = await chromium.launch({
  headless: true,
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
let manifestRequests = 0;
let manifest = files;
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

try {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await page.route("https://tmplistoss.bgydook.cn/api/tmp/files", (route) => {
    manifestRequests += 1;
    return route.fulfill({ json: { code: 200, msg: "ok", data: manifest } });
  });
  await page.addInitScript((initialFiles) => {
    const test = (window.dashboardTest = {
      files: initialFiles,
      scans: 0,
      detections: 0,
      updates: [],
      updateMode: "cancel",
      onProgress: null,
      finish: null,
      exported: null,
      appUpdated: false,
    });
    window.tmpDesktop = {
      isDesktop: true,
      async detectInstallPath() {
        test.detections += 1;
        return {
          ok: true,
          installPath: "C:\\TruckersMP\\installation",
          message: "已自动检测到 TruckersMP",
        };
      },
      async chooseInstallPath() {
        return { ok: false, cancelled: true };
      },
      async scan() {
        test.scans += 1;
        await new Promise((resolve) => setTimeout(resolve, 150));
        return {
          ok: true,
          files: test.files,
          installPath: "C:\\TruckersMP\\installation",
        };
      },
      async update({ paths }) {
        test.updates.push(paths);
        if (test.updateMode === "success") {
          test.files = test.files.map((file) =>
            paths.includes(file.filePath)
              ? { ...file, state: "current", error: undefined }
              : file,
          );
          return {
            ok: true,
            updated: paths.length,
            failed: 0,
            errors: [],
            message: "更新完成",
          };
        }
        if (test.updateMode === "fail") {
          return {
            ok: false,
            updated: 0,
            failed: paths.length,
            errors: paths.map((filePath) => ({
              filePath,
              message: "下载连接中断，请重试",
            })),
            message: "部分文件更新失败",
          };
        }
        test.onProgress?.({
          filePath: paths[0],
          phase: "downloading",
          completed: 0,
          totalFiles: paths.length,
          downloaded: 512,
          overallDownloaded: 512,
          overallTotalBytes: paths.length * 1024,
        });
        return new Promise((resolve) => {
          test.finish = resolve;
        });
      },
      async cancelUpdate() {
        test.finish({
          ok: false,
          cancelled: true,
          updated: 0,
          failed: 0,
          errors: [],
          message: "更新已停止",
        });
        return { ok: true };
      },
      async getBackgroundMode() { return { backgroundMode: true }; },
      async setBackgroundMode(backgroundMode) { return { backgroundMode }; },
      async exportDiagnostics(snapshot) { test.exported = snapshot; return { ok: true }; },
      async checkAppUpdate() {
        return {
          ok: true,
          available: true,
          currentVersion: "1.2.2",
          latestVersion: "1.3.1",
          releaseUrl: "https://cnb.cool/BGYdook/TMP-Updata-app/-/releases/tag/v1.3.1",
          message: "发现新版本 v1.3.1",
        };
      },
      async installAppUpdate() {
        test.appUpdated = true;
        return { ok: true, message: "已下载 v1.3.1 安装包，正在启动安装程序" };
      },
      async openExternal(url) {
        test.opened = url;
        return { ok: true };
      },
      onProgress(callback) {
        test.onProgress = callback;
        return () => {};
      },
    };
  }, files);

  await page.goto("http://127.0.0.1:5173/", { waitUntil: "networkidle" });
  await page.waitForFunction(() =>
    document
      .querySelector(".directory-health")
      ?.textContent.includes("1 个文件检查或更新失败"),
  );
  assert.equal(await page.locator("tbody tr").count(), 3);
  assert.equal(await page.locator(".status-badge.current").count(), 0);
  assert.equal(
    await page
      .getByRole("group", { name: "按文件状态筛选" })
      .getByRole("button", { name: "待更新 3", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.match(
    await page.locator("tbody tr").first().textContent(),
    /locked.bin/,
  );

  await page
    .getByRole("button", { name: /检查异常/ })
    .first()
    .click();
  assert.equal(await page.locator("tbody tr").count(), 1);
  await page.getByRole("button", { name: "文件详情 /data/locked.bin" }).click();
  assert.match(
    await page.getByRole("dialog").textContent(),
    /文件被其他程序占用/,
  );
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.getByRole("button", { name: /全部状态/ }).click();

  await page.getByRole("button", { name: "关于与使用说明" }).click();
  await page.getByRole("dialog", { name: "关于与使用说明" }).getByText("作者：BGYdook").waitFor();
  await page.getByRole("dialog", { name: "关于与使用说明" }).getByRole("button", { name: "API 文档" }).click();
  assert.equal(await page.evaluate(() => window.dashboardTest.opened), "https://tmplistoss.bgydook.cn/docs/");
  await page.getByRole("dialog", { name: "关于与使用说明" }).getByRole("button", { name: "检查更新" }).click();
  await page.getByRole("dialog", { name: "关于与使用说明" }).getByRole("button", { name: "安装 v1.3.1" }).waitFor();
  await page.getByRole("dialog", { name: "关于与使用说明" }).getByRole("button", { name: "安装 v1.3.1" }).click();
  assert.equal(await page.evaluate(() => window.dashboardTest.appUpdated), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("tbody tr").count(), 4);

  // Selecting fewer files must only affect the explicit selection action.
  await page
    .getByRole("checkbox", { name: "选择 /data/missing.bin", exact: true })
    .uncheck();
  await page.getByRole("button", { name: "更新所选", exact: true }).click();
  await page.getByText("准备更新 2 个文件").waitFor();
  const requestsWithDialog = manifestRequests;
  await page.clock.fastForward(300_100);
  assert.equal(manifestRequests, requestsWithDialog);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /智能更新/ }).click();
  await page.getByText("准备更新 3 个文件").waitFor();
  await page.getByRole("button", { name: "开始更新", exact: true }).click();
  await page.getByRole("button", { name: "停止更新", exact: true }).waitFor();
  assert.match(await page.locator(".floating-progress").textContent(), /剩余/);
  assert.equal(
    await page.locator(".stat-card.highlight strong").textContent(),
    "3",
  );
  await page
    .getByRole("group", { name: "按文件状态筛选" })
    .getByRole("button", { name: "待更新 3", exact: true })
    .click();
  assert.equal(await page.locator("tbody tr").count(), 3);
  await page.getByRole("button", { name: /全部状态/ }).click();
  await page.screenshot({ path: "artifacts/dashboard-updating.png" });
  assert.equal(
    await page
      .getByRole("button", { name: "检查更新", exact: true })
      .isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "停止更新", exact: true }).click();
  await page.waitForFunction(
    () =>
      !document.querySelector(".floating-progress") &&
      !document.querySelector(".directory-health.working"),
  );
  assert.equal(await page.locator(".status-badge.missing").count(), 1);
  assert.deepEqual(
    await page.evaluate(() =>
      window.dashboardTest.updates.map((paths) => paths.length),
    ),
    [3],
  );

  // A rescan must retain the download error so the user can inspect and retry it.
  await page.evaluate(() => {
    window.dashboardTest.updateMode = "fail";
  });
  await page
    .locator("tbody tr")
    .filter({ hasText: "outdated.bin" })
    .getByRole("button", { name: "更新", exact: true })
    .click();
  await page.getByRole("button", { name: "开始更新", exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector("tbody")
      ?.textContent.includes("下载连接中断，请重试"),
  );
  assert.equal(await page.locator(".status-badge.error").count(), 2);
  await page.getByRole("button", { name: "重试失败文件" }).waitFor();
  await page.getByRole("button", { name: "重试失败文件" }).click();
  await page.getByText("准备更新 2 个文件").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "导出日志" }).click();
  assert.equal(await page.evaluate(() => window.dashboardTest.exported.files.length), 4);

  // A periodic check must fetch the new manifest as well as checking local files.
  manifest = [
    ...files,
    { ...files[0], filePath: "/data/new-release.bin", state: "missing" },
  ];
  await page.evaluate((nextFiles) => {
    window.dashboardTest.files = nextFiles;
  }, manifest);
  const requestsBefore = manifestRequests;
  await page.clock.fastForward(300_100);
  await page.waitForFunction(
    () =>
      document.querySelectorAll("tbody tr").length === 4 &&
      !document.querySelector(".directory-health.working"),
  );
  assert.equal(manifestRequests, requestsBefore + 1);
  assert.equal(await page.locator(".status-badge.current").count(), 0);
  await page.screenshot({ path: "artifacts/dashboard-scanned.png" });
  await page.getByRole("button", { name: "切换深色模式" }).click();
  await page.clock.fastForward(5000);
  await page.screenshot({ path: "artifacts/dashboard-scanned-dark.png" });

  await page.setViewportSize({ width: 1080, height: 800 });
  const compact = await page.locator(".directory-card").boundingBox();
  assert.ok(
    compact.width > 750,
    `Directory card is unexpectedly narrow: ${compact.width}`,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.fastForward(1000);
  await page.screenshot({ path: "artifacts/dashboard-mobile.png" });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    390,
    JSON.stringify(
      await page.evaluate(() =>
        [...document.querySelectorAll("body *")]
          .map((element) => ({
            className: String(element.className),
            left: element.getBoundingClientRect().left,
            right: element.getBoundingClientRect().right,
          }))
          .filter(
            (box) =>
              box.right > window.innerWidth && box.left < window.innerWidth,
          ),
      ),
    ),
  );
  assert.deepEqual(errors, []);

  // Once every pending file is updated, the list automatically shows all files.
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.evaluate(() => {
    window.dashboardTest.updateMode = "success";
  });
  await page.getByRole("button", { name: /智能更新/ }).click();
  await page.getByText("准备更新 4 个文件").waitFor();
  await page.getByRole("button", { name: "开始更新", exact: true }).click();
  await page.getByText("全部文件已是最新，显示完整清单").waitFor();
  assert.equal(await page.locator("tbody tr").count(), 5);
  assert.equal(await page.locator(".status-badge.current").count(), 5);
  assert.equal(
    await page
      .getByRole("button", { name: "全部状态 5", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await page.screenshot({ path: "artifacts/dashboard-all-current.png" });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        manifestRequests,
        filtered: true,
        autoPending: true,
        autoAllWhenCurrent: true,
        separateBatchActions: true,
        cancelled: true,
        retainedFailure: true,
        periodicRefresh: true,
        responsive: true,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
