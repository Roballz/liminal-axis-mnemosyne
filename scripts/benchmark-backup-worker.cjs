/** Optional real-browser benchmark. Requires Playwright and a Chromium installation.
 * Run from any directory: node scripts/benchmark-backup-worker.cjs
 * CHROMIUM_PATH optionally selects an installed Chromium executable.
 * Uses a fresh isolated browser profile, synthetic IndexedDB, and in-memory disk.
 * This measures browser main-thread responsiveness, not TT native-bridge overhead.
 */
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
async function main() {
  const { chromium } = require('playwright');
  const vite = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
  const server = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', '4179', '--strictPort'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let browser;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Vite startup timed out')), 15000);
      server.once('error', error => { clearTimeout(timer); reject(error); });
      server.once('exit', code => { clearTimeout(timer); reject(new Error(`Vite exited: ${code}`)); });
      server.stdout.on('data', data => {
        if (data.toString().includes('127.0.0.1:4179')) { clearTimeout(timer); resolve(); }
      });
      server.stderr.on('data', data => process.stderr.write(data));
    });
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    });
    const page = await browser.newPage();
    page.on('pageerror', error => console.error(error));
    await page.goto('http://127.0.0.1:4179/evals/backup-worker-responsiveness.html');
    await page.waitForFunction(() => document.querySelector('#result').textContent !== 'Running synthetic backup test', null, { timeout: 300000 });
    const text = await page.locator('#result').innerText();
    console.log(text);
    const results = JSON.parse(text);
    if (results.some(result => result.error || result.outcome !== 'saved' || result.removes !== 2 || result.files !== 5)) {
      throw new Error('Synthetic backup/rotation did not complete correctly');
    }
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
