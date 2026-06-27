// ui/eventbot-sortable.js を生成する（SortableJS を IIFE バンドル・ADR 0015）。
// Worker は ./ui のみ配信するため、SortableJS を1本のJSにまとめ ui/ へ出力し
// ui/index.html から <script src="/eventbot-sortable.js"> で読み込む（CDN非依存）。
// 実行: node design-system/build-ui-sortable.mjs
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// ponytail: (c) esbuild stdin で SortableJS を window.Sortable にバインド（一時ファイル書出しを排除）。
await build({
  stdin: {
    contents: "import Sortable from 'sortablejs';\nwindow.Sortable = Sortable;\n",
    resolveDir: join(here, 'src'),
    loader: 'ts',
  },
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
