// ui/eventbot-sortable.js を生成する（SortableJS を IIFE バンドル・ADR 0015）。
// Worker は ./ui のみ配信するため、SortableJS を1本のJSにまとめ ui/ へ出力し
// ui/index.html から <script src="/eventbot-sortable.js"> で読み込む（CDN非依存）。
// 実行: node design-system/build-ui-sortable.mjs
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));

// 一時的なエントリーポイントを作って、SortableJS を `window.Sortable` にバインドする
const entrySrc = `
import Sortable from 'sortablejs';
window.Sortable = Sortable;
`;
const entryPath = join(here, 'src', '_ui-sortable-entry.ts');
writeFileSync(entryPath, entrySrc, 'utf8');

await build({
  entryPoints: [entryPath],
  outfile: join(here, '..', 'ui', 'eventbot-sortable.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2019'],
  minify: true,
  legalComments: 'none',
  logLevel: 'info',
});

console.log('✅ built ui/eventbot-sortable.js (SortableJS bundle)');
