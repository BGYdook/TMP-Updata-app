import { chromium } from "playwright-core";

const browser = await chromium.launch({
  headless: true,
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  colorScheme: "dark",
});
const page = await context.newPage();

try {
  await page.goto("http://127.0.0.1:5173/", { waitUntil: "networkidle" });
  const initial = await page.evaluate(() => document.documentElement.dataset.theme);
  if (initial !== "dark") throw new Error(`Expected dark theme, received ${initial}`);

  await page.screenshot({ path: "artifacts/theme-dark.png" });
  await page.getByRole("button", { name: "切换浅色模式" }).click();
  const light = await page.evaluate(() => document.documentElement.dataset.theme);
  if (light !== "light") throw new Error(`Expected light theme, received ${light}`);

  await page.reload({ waitUntil: "networkidle" });
  const persisted = await page.evaluate(() => document.documentElement.dataset.theme);
  if (persisted !== "light") throw new Error(`Theme was not persisted: ${persisted}`);

  await page.getByRole("button", { name: "切换深色模式" }).click();
  await page.getByRole("button", { name: "使用说明" }).click();
  const modalBackground = await page
    .locator(".modal")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  if (modalBackground !== "rgb(23, 28, 35)") {
    throw new Error(`Unexpected dark modal background: ${modalBackground}`);
  }

  console.log(JSON.stringify({ initial, toggled: light, persisted, modalBackground }, null, 2));
} finally {
  await context.close();
  await browser.close();
}
