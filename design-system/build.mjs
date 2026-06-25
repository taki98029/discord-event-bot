import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

// React コンポーネントを ESM バンドルに。react 系は consumer（/design-sync の
// レンダラ等）が供給するので external のまま。
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  sourcemap: true,
  logLevel: 'info',
});

// 共有CSSコアを配布物にも同梱（styles.css = styles/index.css の import 閉包）。
mkdirSync('dist/styles', { recursive: true });
cpSync('styles', 'dist/styles', { recursive: true });

// styles/index.css の @import を解決した「平坦化済み・単一ファイル」も出力する。
// 相対 @import を辿らないツール（例: /design-sync コンバータ）向けの自己完結CSS。
await build({
  entryPoints: ['styles/index.css'],
  outfile: 'dist/styles/index.bundle.css',
  bundle: true,
  logLevel: 'info',
});

console.log('✅ build:ds done → dist/index.js (+ dist/styles/ + dist/styles/index.bundle.css)');
