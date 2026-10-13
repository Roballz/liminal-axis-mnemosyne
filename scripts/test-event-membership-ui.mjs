// Synthetic browser-only host. Block every external request; no real TT data or model calls.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
const require = createRequire(`${process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES}/playwright/package.json`);
const { chromium } = require('playwright');
const port = 4178, base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port)], { stdio: 'ignore' });
let browser;
const output = process.env.MN_MEMBERSHIP_SCREENSHOTS || '/tmp/mnemosyne-membership-ui'; mkdirSync(output, { recursive: true });
try {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/scripts/daily-smoke.html`)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ executablePath: process.env.MN_CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
  await page.goto(`${base}/scripts/daily-smoke.html`); await page.waitForFunction(() => window.__smoke?.ready);
  await page.evaluate(async () => {
    const s = window.__smoke, bridge = await import('/src/mnemosyne/bridge.ts');
    const { activeLibrary } = await import('/src/mnemosyne/db.ts');
    const { editEvent } = await import('/src/mnemosyne/events.ts');
    const { saveMemberships } = await import('/src/mnemosyne/event-memberships.ts');
    s.ctx.chat = Array.from({ length: 100 }, (_, i) => ({ name: i % 2 ? '角色' : '用户', is_user: i % 2 === 0, is_system: false,
      mes: `合成正文 ${i}。` + '这段内容只用于确认选择器不重复读取全文。'.repeat(100),
      extra: i % 2 ? { bbs_leaf: { id: `bulk-leaf-${i}`, text: `${i % 3 === 0 ? '灯会' : '调查'} 合成摘要 ${i}`, delta: {}, createdAt: 1, swipe: 0, v: 1 } } : {} }));
    bridge.invalidateDaily(); let view = await bridge.syncDaily(); const lib = await activeLibrary();
    s.chain = (await saveMemberships(lib, view, { mode: 'add', memories: [view.memories[0].id], eventIds: [], newTitle: '关系线' })).created;
    for (let i = 0; i < 22; i++) { view = await bridge.syncDaily(); await editEvent(lib, view, null, { title: `测试链 ${String(i).padStart(2, '0')}`, status: 'open', keywords: [] }); }
    await bridge.syncDaily();
    s.lib = lib; s.ui.open = false;
    const el = document.createElement('div'); el.id = 'test-floor'; document.body.appendChild(el); s.floorApp = await s.mountFloor(el);
    const { Transaction } = await import('/src/mnemosyne/db.ts');
    const get = Transaction.prototype.get; s.bodyReads = 0;
    Transaction.prototype.get = function(store, ...args) { if (store === 'source_bodies' || store === 'source_revisions') s.bodyReads++; return get.call(this, store, ...args); };
  });
  const button = page.getByRole('button', { name: '事件链：关系线', exact: true }); await button.waitFor();
  await button.click(); let dialog = page.getByRole('dialog', { name: '管理事件链关联', exact: true }); await dialog.waitFor();
  assert.equal(await dialog.getByText('立即更新', { exact: true }).count(), 0);
  await dialog.getByLabel('查找事件链', { exact: true }).fill('关系线');
  await dialog.getByRole('checkbox').uncheck();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await button.waitFor();
  await button.click(); await dialog.getByLabel('查找事件链', { exact: true }).fill('关系线');
  await dialog.getByRole('checkbox').uncheck();
  await dialog.getByRole('button', { name: '新建事件链', exact: true }).click();
  await dialog.getByLabel('新事件链名称', { exact: true }).fill('调查线');
  await page.screenshot({ path: `${output}/mobile-single.png`, fullPage: true });
  await dialog.getByRole('button', { name: '保存关联', exact: true }).click();
  await page.getByRole('button', { name: '事件链：调查线', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__smoke.bodyReads), 0, 'card open/save must not read source bodies');
  await page.evaluate(async () => { const { openMemberships } = await import('/src/mnemosyne/event-membership-ui.ts'); await openMemberships({ eventId: window.__smoke.chain }); });
  dialog = page.getByRole('dialog', { name: '批量加入事件链', exact: true }); await dialog.waitFor();
  assert.equal(await dialog.locator('.mn-membership-rows input').count(), 20);
  await dialog.getByRole('button', { name: '选择本页', exact: true }).click();
  await dialog.getByRole('button', { name: '下一页摘要', exact: true }).click();
  await dialog.locator('.mn-membership-rows input').first().check();
  assert.match(await dialog.getByRole('status').textContent(), /已选 21 条摘要/);
  await dialog.getByLabel('楼层范围', { exact: true }).fill('1-9,21');
  await dialog.getByLabel('摘要关键词', { exact: true }).fill('灯会');
  assert.equal(await dialog.locator('.mn-membership-rows input').count(), 3);
  assert.match(await dialog.getByRole('status').textContent(), /已选 21 条摘要/);
  await dialog.getByRole('button', { name: '清空选择', exact: true }).click();
  await dialog.getByRole('button', { name: '选择全部筛选结果', exact: true }).click();
  assert.match(await dialog.getByRole('status').textContent(), /已选 3 条摘要/);
  await dialog.getByRole('button', { name: '下一页事件链', exact: true }).click();
  assert.match(await dialog.getByRole('status').textContent(), /新增 3 条关联/);
  await dialog.getByRole('button', { name: '从聊天摘要卡勾选', exact: true }).click();
  await page.getByRole('region', { name: '事件链多选', exact: true }).waitFor();
  await page.locator('#test-floor').getByRole('checkbox').check();
  await page.getByRole('button', { name: '选择目标链', exact: true }).click(); await dialog.waitFor();
  assert.match(await dialog.getByRole('status').textContent(), /已选 4 条摘要/);
  await page.screenshot({ path: `${output}/mobile-bulk.png`, fullPage: true });
  await dialog.getByRole('button', { name: '确认加入', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.__smoke.bodyReads), 0, 'bulk scan/save must not read source bodies');
  await page.getByRole('button', { name: /^事件链：.*\+1$/ }).waitFor();
  // Escape restores unchanged data; a newer chat closes the old session rather than committing it.
  await page.getByRole('button', { name: /^事件链：.*\+1$/ }).click();
  dialog = page.getByRole('dialog', { name: '管理事件链关联', exact: true }); await dialog.waitFor();
  await dialog.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: /^事件链：.*\+1$/ }).click(); await dialog.waitFor();
  await page.evaluate(async () => { const bridge = await import('/src/mnemosyne/bridge.ts'); window.__smoke.ctx.getCurrentChatId = () => 'different-chat'; bridge.invalidateDaily(); });
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, bodyReads: await page.evaluate(() => window.__smoke.bodyReads), screenshots: output,
    checked: ['single replace/create/cancel', 'no AI action', '20-row bounded DOM', 'cross-page/filter/chain-page selection', 'range+keyword', 'host-card selection', 'dedup counts', 'multi-chain badge', 'Escape', 'chat switch', 'zero source reads'] }));
} finally { await browser?.close(); server.kill(); }
