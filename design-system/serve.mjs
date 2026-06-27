// 最小静的プレビューサーバ（design-system / 管理 UI 両対応）。
//   既定        : design-system/ ルートを 5577 で配信、`/` = preview.html
//   `--ui` 指定 : ui/ ルートを 5578 で配信、`/` = index.html
// PORT env で port を上書き可能。
// ponytail: (b) serve.mjs と serve-ui.mjs の 2 ファイル重複を `--ui` フラグで統合。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const isUi = process.argv.includes('--ui');
const ROOT = isUi ? join(here, '..', 'ui') : here;
const INDEX = isUi ? '/index.html' : '/preview.html';
const PORT = Number(process.env.PORT) || (isUi ? 5578 : 5577);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (p === '/' || p === '') p = INDEX;
    const file = join(ROOT, normalize(p).replace(/^([\\/])+/, ''));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}).listen(PORT, () =>
  console.log(`${isUi ? 'ui' : 'design-system'} preview: http://localhost:${PORT}${INDEX}`),
);
