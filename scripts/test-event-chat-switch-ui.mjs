// Synthetic host chats only; never reads TT data or calls a model.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const require = createRequire(`${process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES}/playwright/package.json`);
const { chromium } = require('playwright');
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '4174'], { stdio: 'ignore' });
let browser;
try {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch('http://127.0.0.1:4174/scripts/daily-smoke.html')).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ executablePath: process.env.MN_CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith('http://127.0.0.1:4174/') ? route.continue() : route.abort());
  await page.goto('http://127.0.0.1:4174/scripts/daily-smoke.html');
  await page.waitForFunction(() => window.__smoke?.ready);
  await page.evaluate(async () => {
    const s = window.__smoke, bridge = await import('/src/mnemosyne/bridge.ts');
    const { activeLibrary } = await import('/src/mnemosyne/db.ts');
    const { editEvent, setEventArchived } = await import('/src/mnemosyne/events.ts');
    const other = { chat: s.ctx.chat, meta: s.ctx.chatMetadata, name: s.ctx.getCurrentChatId() };
    const parentView = await bridge.syncDaily();
    const lib = await activeLibrary();
    s.ctx.chat = structuredClone(other.chat);
    s.ctx.chatMetadata = structuredClone(other.meta);
    s.ctx.getCurrentChatId = () => 'synthetic-child-chat';
    bridge.invalidateDaily();
    const originalView = await bridge.confirmFork(parentView.branch.id, other.chat.length);
    const original = { chat: s.ctx.chat, meta: s.ctx.chatMetadata, name: s.ctx.getCurrentChatId() };
    await editEvent(lib, originalView, null, { title: '子分支的合成事件', status: 'open', keywords: [] }, { memory: originalView.memories[0].id, active: true, kind: 'progress' });
    const updated = await bridge.syncDaily();
    const archived = await editEvent(lib, updated, null, { title: 'A已结束的合成事件', status: 'resolved', keywords: [] });
    await setEventArchived(lib, await bridge.syncDaily(), archived, true);
    s.switchChat = (name) => {
      const chat = name === 'A' ? original : other;
      s.ctx.chat = chat.chat; s.ctx.chatMetadata = chat.meta; s.ctx.getCurrentChatId = () => chat.name;
      bridge.scheduleDaily();
    };
    s.eventsInStore = () => lib.all('event_chains');
    s.originalBranch = originalView.branch.id;
    s.parentBranch = parentView.branch.id;
    s.ui.activePage = 'events';
  });
  const event = page.locator('.mn-event-card').filter({ hasText: '子分支的合成事件' });
  await event.waitFor();
  await page.evaluate(() => window.__smoke.switchChat('B'));
  await event.waitFor({ state: 'hidden' });
  await page.waitForFunction(async () => {
    const { dailyState } = await import('/src/mnemosyne/bridge.ts');
    return dailyState.branch === window.__smoke.parentBranch && !dailyState.pending;
  });
  await page.evaluate(() => window.__smoke.switchChat('A'));
  await page.waitForFunction(async () => {
    const { dailyState } = await import('/src/mnemosyne/bridge.ts');
    return dailyState.branch === window.__smoke.originalBranch && !dailyState.pending;
  });
  const stored = await page.evaluate(async () => (await window.__smoke.eventsInStore()).length);
  assert.equal(stored, 3, 'same-text parent/child switch keeps all three event records');
  try { await event.waitFor({ timeout: 3000 }); }
  catch (error) {
    console.error(`REPRO: child→identical parent→child persisted ${stored} events, but the page renders ${await page.locator('.mn-event-card').count()}.`);
    throw error;
  }
  await page.getByRole('button', { name: '归档事件', exact: true }).click();
  await page.locator('.mn-event-card').filter({ hasText: 'A已结束的合成事件' }).waitFor();
  await page.getByRole('button', { name: '返回事件', exact: true }).click();
  // Hold one read outside its IDB transaction; late child/parent results must not overwrite the latest scope.
  await page.evaluate(async () => {
    const { activeLibrary } = await import('/src/mnemosyne/db.ts');
    const lib = await activeLibrary(), original = lib.transaction.bind(lib), s = window.__smoke;
    s.holdRead = true;
    lib.transaction = async (...args) => {
      if (args[0].includes('event_chains') && args[1] === 'readonly') {
        if (s.failRead) { s.failRead = false; throw new Error('synthetic read failure'); }
        if (s.holdRead) { s.holdRead = false; await new Promise(resolve => { s.releaseRead = resolve; }); }
      }
      return original(...args);
    };
  });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.waitForFunction(() => !!window.__smoke.releaseRead);
  await page.evaluate(() => { window.__smoke.switchChat('B'); window.__smoke.switchChat('A'); });
  await page.waitForFunction(async () => {
    const { dailyState } = await import('/src/mnemosyne/bridge.ts');
    return dailyState.branch === window.__smoke.originalBranch && !dailyState.pending;
  });
  await page.evaluate(() => window.__smoke.releaseRead());
  await event.waitFor();
  await page.getByText('正在读取当前聊天的事件…', { exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.mn-event-card').filter({ hasText: '玉佩归还' }).count(), 0);
  await page.evaluate(() => { window.__smoke.failRead = true; });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'synthetic read failure' }).waitFor();
  assert.equal(await page.locator('.mn-empty').count(), 0, 'read failure is not an empty library');

  // A real source edit explains filtered cards while keeping all event rows intact.
  await page.evaluate(async () => {
    const { scheduleDaily, syncDaily } = await import('/src/mnemosyne/bridge.ts');
    window.__smoke.ctx.chat[0].mes += '\n合成正文差异';
    scheduleDaily(); await syncDaily();
  });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '当前分支已保存 2 条事件' }).waitFor();
  assert.equal(await page.locator('.mn-event-card').count(), 0);
  assert.equal(await page.locator('.mn-empty').count(), 0, 'filtered history is not reported as no events');
  assert.equal(await page.evaluate(async () => (await window.__smoke.eventsInStore()).length), 3);
  await page.evaluate(() => { window.__smoke.ui.activePage = 'archive'; });
  await page.getByText('待审核摘要 · 1', { exact: true }).click();
  // Audit actual IDB and host writes after the independent background archive has completed.
  await page.evaluate(() => {
    const s = window.__smoke; s.reviewWrites = 0;
    for (const key of ['put', 'add', 'delete', 'clear']) {
      const original = IDBObjectStore.prototype[key];
      IDBObjectStore.prototype[key] = function(...args) { s.reviewWrites++; return original.apply(this, args); };
    }
    s.ctx.saveChat = s.ctx.saveMetadata = async () => { s.reviewWrites++; };
  });
  await page.getByRole('button', { name: '加载待审核项（只读）', exact: true }).click();
  await page.getByRole('button', { name: '查看来源差异', exact: true }).click();
  await page.getByText('只读检查：原来源楼层 #0', { exact: true }).waitFor();
  await page.locator('.mn-review-difference').filter({ hasText: '合成正文差异' }).waitFor();
  assert.equal(await page.evaluate(() => window.__smoke.reviewWrites), 0, 'loading and diagnosis write neither host nor IDB');
  await page.evaluate(() => window.__smoke.switchChat('B'));
  await page.getByText('只读检查：原来源楼层 #0', { exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: '保留摘要（仅当前版本）', exact: true }).count(), 0, 'old review actions cleared on scope change');
  assert.deepEqual(errors, []);
  console.log('PASS: identical parent/child round trip; delayed reads and rapid switches; read failures; persisted-but-filtered events; readonly source diagnosis with zero IDB/host writes; review scope isolation. No model calls.');
} finally { await browser?.close(); server.kill(); }
