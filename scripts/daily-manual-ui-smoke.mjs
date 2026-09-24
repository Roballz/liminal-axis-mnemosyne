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
    window.__smoke.ctx.chat[1].extra.bbs_leaf.text =
      "合成约会记录：早餐后一起逛街做花灯，晚间取灯继续游览。".repeat(16);
    const el = document.createElement("div");
    el.id = "synthetic-floor";
    document.body.prepend(el);
    // Match TT: the floor is in a shadow root beneath a clipping, transformed message.
    el.style.cssText =
      "position:fixed;left:0;top:150px;width:100%;height:84px;overflow:hidden;transform:translateZ(0)";
    const shadow = el.attachShadow({ mode: "open" }),
      content = document.createElement("div");
    shadow.append(content);
    await window.__smoke.mountFloor(content);
    document.head
      .querySelectorAll("style")
      .forEach((style) => shadow.append(style.cloneNode(true)));
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
  await page.locator(".bbs-overlay").waitFor({ state: "hidden" });
  const trigger = floor.getByRole("button", {
    name: "添加事件链",
    exact: true,
  });
  const popup = page.getByRole("menu", { name: "事件链操作", exact: true });
  const assertPopup = async () => {
    const bounds = await popup.boundingBox();
    assert.ok(
      bounds.x >= 7 &&
        bounds.y >= 7 &&
        bounds.x + bounds.width <= 391 &&
        bounds.y + bounds.height <= 845,
    );
    assert.equal(await popup.locator("button").count(), 2);
    assert.equal(
      await popup.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return el.contains(
          document.elementFromPoint(r.x + r.width / 2, r.bottom - 15),
        );
      }),
      true,
      "menu remains hit-testable outside clipped floor",
    );
    return bounds;
  };
  await trigger.click();
  const below = await assertPopup(),
    clipping = await floor.boundingBox();
  assert.ok(
    below.y + below.height > clipping.y + clipping.height,
    "menu escapes message clipping",
  );
  await page.keyboard.press("Escape");
  await popup.waitFor({ state: "hidden" });
  assert.equal(
    await trigger.evaluate((el) => el.getRootNode().activeElement === el),
    true,
  );
  await floor.evaluate((el) => {
    el.style.top = `${window.innerHeight - 110}px`;
  });
  await trigger.click();
  const above = await assertPopup(),
    anchor = await trigger.boundingBox();
  assert.ok(
    above.y + above.height <= anchor.y,
    "bottom-edge popup opens upward",
  );
  await page.keyboard.press("ArrowDown");
  assert.equal(
    await popup
      .getByRole("menuitem", { name: "加入已有链" })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.mouse.click(10, 10);
  await popup.waitFor({ state: "hidden" });
  await floor.evaluate((el) => {
    el.style.top = "150px";
  });
  for (const theme of ["day", "night"]) {
    await page.evaluate((theme) => {
      window.__smoke.ui.theme = theme;
    }, theme);
    await trigger.click();
    await assertPopup();
    await page.screenshot({
      path: `/tmp/w01-polish-menu-${theme}.png`,
      fullPage: true,
    });
    await page.keyboard.press("Escape");
  }
  await trigger.click();
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await popup.waitFor({ state: "hidden" });
  await trigger.click();
  await floor.evaluate((el) => el.dispatchEvent(new Event("scroll")));
  await popup.waitFor({ state: "hidden" });
  await page.evaluate(() => {
    window.__smoke.ui.theme = "day";
  });
  await floor.getByRole("button", { name: "添加事件链", exact: true }).click();
  await page.getByRole("menuitem", { name: "新建事件链", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "新建事件链", exact: true });
  await dialog
    .getByLabel("事件链说明", { exact: true })
    .fill("把这一天的约会当成一个整体");
  const colors = await dialog.evaluate((el) =>
    [...el.querySelectorAll("footer button")].map(
      (b) => getComputedStyle(b).backgroundColor,
    ),
  );
  assert.notEqual(
    colors[0],
    colors[1],
    "cancel stays neutral while create is primary",
  );
  await dialog.getByRole("button", { name: "新建", exact: true }).click();
  assert.equal(await page.evaluate(() => window.__smoke.calls.length), 0);
  const confirm = page.getByRole("dialog", { name: "确认调用摘要 API" });
  // Budget rejection must remain visible until acknowledged, outside the clipped card.
  await page.evaluate(async () => {
    const { settings } = await import("/src/mnemosyne/jobs.ts");
    window.__smoke.maxChars = settings.maxChars;
    settings.maxChars = 1;
  });
  await confirm.getByRole("button", { name: "确认发送" }).click();
  const failure = page.getByRole("alertdialog", { name: "操作未完成" });
  await failure
    .getByText("事件请求超过字符预算，未发送", { exact: true })
    .waitFor();
  assert.equal(await page.evaluate(() => window.__smoke.calls.length), 0);
  await page.mouse.click(5, 5);
  await page.keyboard.press("Escape");
  assert.equal(
    await failure.isVisible(),
    true,
    "feedback needs explicit acknowledgement",
  );
  assert.equal(await floor.locator(".mn-floor-event > small").count(), 0);
  await page.waitForTimeout(250);
  await page.screenshot({
    path: "/tmp/w01-event-feedback-error.png",
    fullPage: true,
  });
  await failure.getByRole("button", { name: "确定", exact: true }).click();
  await failure.waitFor({ state: "hidden" });
  assert.equal(
    await dialog.getByLabel("事件链说明", { exact: true }).inputValue(),
    "把这一天的约会当成一个整体",
  );
  await page.evaluate(async () => {
    const { settings } = await import("/src/mnemosyne/jobs.ts");
    settings.maxChars = window.__smoke.maxChars;
  });
  await dialog.getByRole("button", { name: "新建", exact: true }).click();
  await confirm.getByRole("button", { name: "确认发送" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => window.__smoke.calls.length), 1);
  const success = page.getByRole("alertdialog", { name: "操作完成" });
  await success.getByText("事件已保存", { exact: true }).waitFor();
  assert.equal(await success.locator("button").count(), 1);
  assert.equal(await floor.locator(".mn-floor-event > small").count(), 0);
  await page.waitForTimeout(250);
  await page.screenshot({
    path: "/tmp/w01-event-feedback-success.png",
    fullPage: true,
  });
  await success.getByRole("button", { name: "确定", exact: true }).click();
  await success.waitFor({ state: "hidden" });
  await floor.getByRole("button", { name: "添加事件链", exact: true }).click();
  await page.getByRole("menuitem", { name: "加入已有链", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "加入已有链", exact: true });
  await dialog.getByRole("button", { name: "已有事件链", exact: true }).click();
  await page.getByRole("option", { name: "一日约会", exact: true }).click();
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  assert.equal(
    await dialog
      .getByRole("button", { name: "立即更新", exact: true })
      .isVisible(),
    true,
  );
  await dialog.getByRole("button", { name: "仅入库", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => window.__smoke.calls.length), 1);
  await success
    .getByText("本楼已在事件链中，未调用模型更新概要", { exact: true })
    .waitFor();
  await success.getByRole("button", { name: "确定", exact: true }).click();
  await success.waitFor({ state: "hidden" });
  await page.evaluate(() => {
    document.getElementById("synthetic-floor").style.display = "none";
    window.__smoke.ui.open = true;
    window.__smoke.ui.activePage = "events";
  });
  const event = page.locator(".mn-event-card").filter({ hasText: "一日约会" });
  await event.waitFor();
  assert.equal(await event.getByText("最新进展：", { exact: true }).count(), 0);
  await event.getByRole("button", { name: "编辑", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "编辑事件", exact: true });
  await dialog.getByLabel("标题", { exact: true }).fill("整日约会");
  await dialog.getByLabel("事件概要", { exact: true }).fill("核".repeat(501));
  assert.equal(
    await dialog
      .getByRole("button", { name: "保存", exact: true })
      .isDisabled(),
    true,
  );
  await dialog
    .getByLabel("事件概要", { exact: true })
    .fill("核".repeat(499) + "🌸");
  await dialog.getByText("500 / 500 字", { exact: false }).waitFor();
  assert.equal(
    await dialog.getByRole("button", { name: "保存", exact: true }).isEnabled(),
    true,
  );
  await dialog.getByLabel("事件概要", { exact: true }).fill("人工修订概要");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const changed = page
    .locator(".mn-event-card")
    .filter({ hasText: "整日约会" });
  await changed.locator(":scope > summary").click();
  await changed.getByText("人工修订概要", { exact: false }).waitFor();
  await changed.getByText("完整追加史", { exact: true }).click();
  const member = changed.locator(".mn-member-detail").first();
  await member.getByText("完整摘要", { exact: true }).click();
  const widths = await member.evaluate((el) => ({
    container: el.getBoundingClientRect().width,
    body: el.querySelector("p").getBoundingClientRect().width,
    overflow:
      el.querySelector("p").scrollWidth - el.querySelector("p").clientWidth,
    button: el.querySelector("button").getBoundingClientRect().width,
    buttonHeight: el.querySelector("button").getBoundingClientRect().height,
  }));
  assert.ok(
    Math.abs(widths.container - widths.body) < 2,
    "expanded summary gets full row width",
  );
  assert.ok(
    widths.button < 85 && widths.buttonHeight <= 34,
    "unlink is a compact secondary action",
  );
  const originalText = await member.locator("p").textContent();
  assert.ok(originalText.length > 300);
  await changed.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250); // settle theme/dialog transitions before visual capture
  await page.screenshot({
    path: "/tmp/w01-manual-events-mobile.png",
    fullPage: true,
  });
  await member.getByRole("button", { name: "移除关联", exact: true }).click();
  await changed.getByText("进行中 · 0 条关联", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__smoke.calls.length), 1);
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
    "PASS: synthetic mobile clipped floor popup; acknowledged success/budget-error dialogs with no inline feedback; shortened join labels; no latest-progress card block; Unicode 500-character overview edit limit; full-width member summary; API confirmation, one-call creation, duplicate join with no API, event edit/delete confirmation, raw table backfill and durable last floor; no page errors.",
  );
} finally {
  await browser?.close();
  server.kill();
}
