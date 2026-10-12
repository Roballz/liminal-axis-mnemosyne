import { defineConfig } from 'vite';
import { writeFileSync } from 'node:fs';

export default defineConfig({
  plugins: [{ name: 'rescue-manifest', closeBundle() {
    writeFileSync('rescue-build/manifest.json', JSON.stringify({
      display_name: 'Mnemosyne 只读救援（普通功能停用）', loading_order: 100,
      requires: [], optional: [], js: 'dist/rescue.js?ver=rescue-1',
      author: 'Roballz', version: '1.3.15-rescue.1', auto_update: false,
      homePage: 'https://github.com/Roballz/liminal-axis-mnemosyne', minimum_client_version: '1.12.13',
    }, null, 2) + '\n');
  } }],
  build: { outDir: 'rescue-build', emptyOutDir: true, target: 'es2022', minify: false, sourcemap: false,
    rollupOptions: { input: 'src/rescue/index.ts', output: { format: 'es', entryFileNames: 'dist/rescue.js' } },
  },
});
