// ui/eventbot-tables.js を生成する（②・TanStack table-core を IIFE バンドル）。
// Worker は ./ui のみ配信するため、table-core を1本のJSにまとめ ui/ へ出力し
// ui/index.html から <script src="/eventbot-tables.js"> で読み込む（CDN非依存）。
// 実行: node design-system/build-ui-tables.mjs
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(here, 'src', 'ui-tables.ts')],
  outfile: join(here, '..', 'ui', 'eventbot-tables.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2019'],
  minify: true,
  legalComments: 'none',
  logLevel: 'info',
});

console.log('✅ built ui/eventbot-tables.js (table-core bundle)');
