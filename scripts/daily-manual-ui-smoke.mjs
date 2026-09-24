// Local synthetic browser test. All non-local requests are blocked; no TT or model provider is contacted.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const { chromium } = process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
  ? createRequire(
      `${process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES}/playwright/package.json`,
    )("playwright")
  : require("playwright");
const server = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "4173"],
  { stdio: "ignore" },
);
let browser;
try {
  for (let n = 0; n < 40; n++) {
    try {
      if ((await fetch("http://127.0.0.1:4173/scripts/daily-smoke.html")).ok)
        break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.MN_CHROMIUM_PATH || undefined,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", (route) =>
    route.request().url().startsWith("http://127.0.0.1:4173/")
      ? route.continue()
      : route.abort(),
  );
  await page.goto("http://127.0.0.1:4173/scripts/daily-smoke.html");
  if (process.env.MN_TEST_FONT_CSS) {
    const fontPath = process.env.MN_TEST_FONT_CSS;
    const css = readFileSync(fontPath, "utf8").replace(
      /url\(\.\/files\/([^)]*\.woff2)\) format\('woff2'\), url\([^)]*\) format\('woff'\)/g,
      (_, file) =>
        `url(data:font/woff2;base64,${readFileSync(resolve(dirname(fontPath), "files", file)).toString("base64")}) format('woff2')`,
    );
    await page.addStyleTag({
      content: css + "\n.bbs-root{--bbs-font-sans:'Noto Sans SC',sans-serif}",
    });
    await page.evaluate(() => document.fonts.ready);
  }
  await page.waitForFunction(() => window.__smoke?.ready);
  await page.getByRole("heading", { name: "Mnemosyne 档案 / 迁移" }).waitFor();
  assert.equal(
    await page.getByText("正文当前视图", { exact: false }).count(),
    0,
  );
  assert.equal(await page.getByText("摘要与来源", { exact: true }).count(), 0);

  // Mount the real floor card next to the app with synthetic host data only.
  await page.evaluate(async () => {
    window.__smoke.ui.open = false;
    const el = document.createElement("div");
    el.id = "synthetic-floor";
    document.body.prepend(el);
    await window.__smoke.mountFloor(el);
    window.__smoke.calls = [];
    window.__smoke.ctx.name1 = "User";
    window.__smoke.ctx.name2 = "Synthetic";
    window.__smoke.ctx.generateRaw = async ({ prompt }) => {
      window.__smoke.calls.push(prompt);
      return JSON.stringify({
        title: "一日约会",
        status: "open",
        keywords: ["约会"],
        overview: "早餐、花灯与灯会是一日约会的整体。",
        progress: "约会开始。",
      });
    };
  });
  const floor = page.locator("#synthetic-floor");
  await floor.getByRole("button", { name: "添加事件链", exact: true }).click();
  await floor
    .getByRole("menuitem", { name: "新建事件链", exact: true })
    .click();
  let dialog = page.getByRole("dialog", { name: "新建事件链", exact: true });
  await dialog
    .getByLabel("事件链说明", { exact: true })
    .fill("把这一天的约会当成一个整体");
  await dialog.getByRole("button", { name: "新建", exact: true }).click();
  assert.equal(await page.evaluate(() => window.__smoke.calls.length), 0);
  const confirm = page.getByRole("dialog", { name: "确认调用摘要 API" });
  await confirm.getByRole("button", { name: "确认发送" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => window.__smoke.calls.length), 1);
  await floor.getByRole("button", { name: "添加事件链", exact: true }).click();
  await floor
    .getByRole("menuitem", { name: "加入已有链", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "加入已有链", exact: true });
  await dialog.getByRole("button", { name: "已有事件链", exact: true }).click();
  await page.getByRole("option", { name: "一日约会", exact: true }).click();
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await dialog
    .getByRole("button", { name: "不更新概要（仅入库）", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => window.__smoke.calls.length), 1);
  await page.evaluate(() => {
    document.getElementById("synthetic-floor").style.display = "none";
    window.__smoke.ui.open = true;
    window.__smoke.ui.activePage = "events";
  });
  const event = page.locator(".mn-event-card").filter({ hasText: "一日约会" });
  await event.waitFor();
  await event.getByRole("button", { name: "编辑", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "编辑事件", exact: true });
  await dialog.getByLabel("标题", { exact: true }).fill("整日约会");
  await dialog.getByLabel("事件概要", { exact: true }).fill("人工修订概要");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const changed = page
    .locator(".mn-event-card")
    .filter({ hasText: "整日约会" });
  await changed.locator(":scope > summary").click();
  await changed.getByText("人工修订概要", { exact: false }).waitFor();
  await changed.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250); // settle theme/dialog transitions before visual capture
  await page.screenshot({
    path: "/tmp/w01-manual-events-mobile.png",
    fullPage: true,
  });
  await changed.getByRole("button", { name: "删除", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "删除事件链", exact: true });
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await changed.getByRole("button", { name: "删除", exact: true }).click();
  await dialog.getByRole("button", { name: "确认删除", exact: true }).click();
  await changed.waitFor({ state: "hidden" });
  await page.evaluate(async () => {
    const { syncDaily } = await import("/src/mnemosyne/bridge.ts");
    const { activeLibrary } = await import("/src/mnemosyne/db.ts");
    const { newTable, saveTable } = await import("/src/mnemosyne/tables.ts");
    const view = await syncDaily(),
      def = newTable(view, "待补表");
    def.ai = false;
    def.columns = [
      {
        id: "detail",
        name: "细节",
        type: "text",
        mode: "replace",
        description: "",
      },
    ];
    await saveTable(await activeLibrary(), view, def);
    window.__smoke.ctx.generateRaw = async ({ prompt }) => {
      window.__smoke.calls.push(prompt);
      return JSON.stringify({
        customTables: [
          { table_id: def.id, add: [{ detail: "合成正文补填" }], update: [] },
        ],
      });
    };
    window.__smoke.ui.activePage = "tables";
  });
  await page.getByRole("button", { name: "批量补表", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "批量补表", exact: true });
  await dialog.getByRole("checkbox", { name: "待补表", exact: true }).check();
  await page.waitForTimeout(250); // capture the finished modal, not its fade-in
  await page.screenshot({
    path: "/tmp/w01-manual-backfill-mobile.png",
    fullPage: true,
  });
  await dialog
    .getByRole("button", { name: "确认调用 API 补表", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => window.__smoke.calls.length), 2);
  await page.getByRole("button", { name: "批量补表", exact: true }).click();
  await dialog.getByText("#1 → #1 / 共2楼", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: synthetic mobile floor menu, API confirmation, one-call creation, duplicate join with no API, event edit/delete confirmation, disabled-auto table raw backfill and durable last floor; no page errors.",
  );
} finally {
  await browser?.close();
  server.kill();
}
