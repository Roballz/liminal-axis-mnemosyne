// Local synthetic browser test. All non-local requests are blocked; no TT or model provider is contacted.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
  ? createRequire(`${process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES}/playwright/package.json`)('playwright')
  : require('playwright');
const server = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '4173'],
  { stdio: 'ignore' },
);
let browser;
try {
  for (let n = 0; n < 40; n++) {
    try {
      if ((await fetch('http://127.0.0.1:4173/scripts/daily-smoke.html')).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.MN_CHROMIUM_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (route) =>
    route.request().url().startsWith('http://127.0.0.1:4173/') ? route.continue() : route.abort(),
  );
  await page.goto('http://127.0.0.1:4173/scripts/daily-smoke.html');
  if (process.env.MN_TEST_FONT_CSS) {
    const fontPath=process.env.MN_TEST_FONT_CSS;
    const css=readFileSync(fontPath,'utf8').replace(/url\(\.\/files\/([^)]*\.woff2)\) format\('woff2'\), url\([^)]*\) format\('woff'\)/g,(_,file)=>`url(data:font/woff2;base64,${readFileSync(resolve(dirname(fontPath),'files',file)).toString('base64')}) format('woff2')`);
    await page.addStyleTag({content:css+"\n.bbs-root{--bbs-font-sans:'Noto Sans SC',sans-serif}"});
    await page.evaluate(()=>document.fonts.ready);
  }
  await page.waitForFunction(() => window.__smoke?.ready);
  await page.getByRole('heading', { name: 'Mnemosyne 档案 / 迁移' }).waitFor();
  assert.equal(await page.getByText('正文当前视图', { exact: false }).count(), 0);
  assert.equal(await page.getByText('摘要与来源', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '事件', exact: true }).first().click();
  await page.getByRole('heading', { name: '事件', exact: true }).waitFor();
  const event = page
    .locator('.mn-card')
    .filter({ has: page.locator('summary strong', { hasText: '玉佩归还' }) });
  assert.equal(await event.getAttribute('open'), null);
  await event.locator(':scope > summary').click();
  await event.getByText('progress 人工锁定', { exact: true }).waitFor();
  await page.getByRole('button', { name: '表格', exact: true }).click();
  await page.getByRole('heading', { name: '本地自定义表' }).waitFor();
  assert.equal(await page.locator('select').count(), 0);
  const transactionStart = await page.evaluate(() => window.__smoke.transactions.length);
  await page.getByRole('button', { name: '＋ 新建表', exact: true }).click();
  const info = page.getByRole('dialog', { name: '表格信息' });
  await info.getByLabel('表名', { exact: true }).fill('合成事项表');
  await info.getByRole('button', { name: '保存', exact: true }).click();
  await info.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '管理合成事项表' }).click();
  await page
    .getByRole('dialog', { name: '管理表格' })
    .getByRole('button', { name: '设计表', exact: true })
    .click();
  await page.getByRole('heading', { name: '设计 · 合成事项表' }).waitFor();
  const addField = async (name, mode, description, prompt) => {
    await page.getByRole('button', { name: '新增字段', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '字段设计' });
    await dialog.getByLabel('字段名', { exact: true }).fill(name);
    await dialog.getByRole('button', { name: '写入策略' }).click();
    await page.getByRole('option', { name: mode, exact: true }).click();
    await dialog.getByLabel('字段介绍', { exact: true }).fill(description);
    await dialog.getByLabel('填写提示词', { exact: true }).fill(prompt);
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  };
  await addField('事项', '锁定', '具体约定或目标', '只从正文提取具体事项');
  await addField('进展', '追加', '跟踪行动与结果', '仅补充新进展');
  await page.screenshot({ path: '/tmp/w01-tables-design-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '‹ 返回表格' }).click();
  await page.getByRole('button', { name: '新增行', exact: true }).click();
  let edit = page.getByRole('dialog', { name: '编辑记录' });
  await edit.getByLabel('事项', { exact: true }).fill('玉佩归还');
  await edit.getByLabel('进展', { exact: true }).fill('已约定明天归还。');
  await edit.getByRole('button', { name: '保存', exact: true }).click();
  await edit.waitFor({ state: 'hidden' });
  const record = page.locator('.mn-record').filter({ hasText: '玉佩归还' });
  await record.getByRole('button').click();
  await edit.waitFor();
  assert.equal(await edit.getByLabel('事项', { exact: true }).isDisabled(), true);
  const textarea = edit.getByLabel('进展', { exact: true });
  const height = (await textarea.boundingBox()).height;
  const resize = edit.getByRole('button', { name: '拉大进展输入框' });
  const handle = await resize.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 + 60);
  await page.mouse.up();
  assert.ok((await textarea.boundingBox()).height > height);
  await page.screenshot({ path: '/tmp/w01-tables-row-mobile.png', fullPage: true });
  await edit.getByRole('button', { name: '取消', exact: true }).click();
  await edit.waitFor({ state: 'hidden' });
  const box = await record.boundingBox();
  await page.mouse.move(box.x + 50, box.y + 30);
  await page.mouse.down();
  await page.waitForTimeout(550);
  await page.mouse.up();
  await record.getByRole('checkbox', { name: '选择行' }).waitFor();
  assert.equal(await record.getByRole('checkbox').isChecked(), true);
  await page.getByRole('button', { name: '隐藏行', exact: true }).click();
  await record.waitFor({ state: 'hidden' });
  await page.getByLabel('查看隐藏行', { exact: true }).check();
  await record.waitFor();
  await record.getByRole('button').click();
  await edit.waitFor();
  await edit.getByRole('button', { name: '取消', exact: true }).click();
  await edit.waitFor({ state: 'hidden' });
  await page.getByLabel('全选本页', { exact: true }).check();
  await page.getByRole('button', { name: '显示行', exact: true }).click();
  await page.getByText('已隐藏 · 不注入', { exact: true }).waitFor({ state: 'hidden' });
  await page.getByPlaceholder('搜索表内记录').fill('不会匹配');
  await record.waitFor({ state: 'hidden' });
  await page.getByPlaceholder('搜索表内记录').fill('');
  await record.waitFor();
  const accesses = await page.evaluate((start) => window.__smoke.transactions.slice(start), transactionStart);
  assert.ok(
    accesses.every((stores) => !stores.includes('source_revisions') && !stores.includes('memory_revisions')),
    'table UI must not load source or summary bodies',
  );
  await page.getByRole('button', { name: '‹ 所有表格' }).click();
  await page.screenshot({ path: '/tmp/w01-tables-list-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1100, height: 860 });
  await page.screenshot({ path: '/tmp/w01-tables-list-desktop.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    `PASS: synthetic Chromium 390x844 + desktop; archive has no body/summary list; event card; table/field/row CRUD; lock; drag-resize; long-press selection; hide/show; search; ${accesses.length} table-action transactions with zero source/summary-store reads; no page errors. No TT/model calls.`,
  );
} finally {
  await browser?.close();
  server.kill();
}
