// 共有プレビュー足場。DS はダークテーマだが、プレビューカードの body は白で
// 上書きされるため、ここで body を --bg / --text にして実コンポーネントの見た目を
// 忠実に再現する。Frame は単なるレイアウト容器（カードは内容にフィットする）。
import * as React from 'react';

if (typeof document !== 'undefined') {
  document.body.style.background = 'var(--bg)';
  document.body.style.color = 'var(--text)';
}

type FrameProps = {
  children: React.ReactNode;
  /** 縦積み（既定）か横並びか */
  row?: boolean;
  /** 最大幅（フォーム系は 380〜520 が読みやすい） */
  maxWidth?: number;
  gap?: number;
};

export function Frame({ children, row = false, maxWidth, gap = 10 }: FrameProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: row ? 'row' : 'column',
        flexWrap: row ? 'wrap' : 'nowrap',
        alignItems: row ? 'center' : 'stretch',
        gap,
        maxWidth,
      }}
    >
      {children}
    </div>
  );
}
