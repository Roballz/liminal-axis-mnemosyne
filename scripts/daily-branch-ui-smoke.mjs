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
  await page.evaluate(async () => {
    const bridge = await import('/src/mnemosyne/bridge.ts');
    window.__smoke.parent = window.__smoke.ctx.chatMetadata.mnemosyne_binding_v1.branch;
    window.__smoke.ctx.getCurrentChatId = () => 'synthetic-fork';
    bridge.invalidateDaily();
    try { await bridge.syncDaily(); } catch {}
  });
  const select = page.getByRole('button', { name: '来源聊天', exact: true });
  await select.waitFor();
  await page.getByText('synthetic-browser-smoke · 2 条消息 · 当前聊天的来源', { exact: true }).waitFor();
  assert.equal(await page.getByText('已有分支 ID', { exact: true }).count(), 0);
  await select.evaluate(el => el.scrollIntoView({block: 'center'}));
  await select.click();
  await page.getByRole('option', { name: '请选择来源聊天', exact: true }).click();
  const fork = page.getByRole('button', { name: '继承档案', exact: true });
  assert.equal(await fork.isDisabled(), true);
  await select.evaluate(el => el.scrollIntoView({block: 'center'}));
  await select.click();
  await page.getByRole('option', { name: 'synthetic-browser-smoke · 2 条消息 · 当前聊天的来源', exact: true }).click();
  assert.equal(await page.getByRole('spinbutton').inputValue(), '2');
  assert.equal(await fork.isDisabled(), false);
  await fork.click();
  await select.waitFor({ state: 'hidden' });
  const result = await page.evaluate(async () => {
    const {activeLibrary} = await import('/src/mnemosyne/db.ts');
    const lib = await activeLibrary();
    return { branches: (await lib.all('branches')).length,
      changed: window.__smoke.ctx.chatMetadata.mnemosyne_binding_v1.branch !== window.__smoke.parent };
  });
  assert.deepEqual(result, {branches: 2, changed: true});
  assert.deepEqual(errors, []);
  console.log('PASS: mobile 390x844 source dropdown, inherited selection, empty selection blocks action, suggested count, explicit fork creates second branch; no page errors or model calls.');
} finally {
  await browser?.close();
  server.kill();
}
