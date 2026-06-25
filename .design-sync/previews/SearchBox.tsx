import * as React from 'react';
import { SearchBox } from '@eventbot/design-system';
import { Frame } from '../_frame';

// アイコン付き検索。.search の position: relative を使い 🔍 を左に絶対配置し、
// input は左パディングでアイコン分を空ける。
export const WithIcon = () => (
  <Frame maxWidth={360}>
    <SearchBox>
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: 11,
          top: '50%',
          transform: 'translateY(-50%)',
          opacity: 0.6,
          pointerEvents: 'none',
        }}
      >
        🔍
      </span>
      <input
        type="search"
        placeholder="サーバー参加者を検索"
        style={{ paddingLeft: 34 }}
      />
    </SearchBox>
  </Frame>
);

// 入力済みの状態。
export const Filled = () => (
  <Frame maxWidth={360}>
    <SearchBox>
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: 11,
          top: '50%',
          transform: 'translateY(-50%)',
          opacity: 0.6,
          pointerEvents: 'none',
        }}
      >
        🔍
      </span>
      <input type="search" defaultValue="さくら" style={{ paddingLeft: 34 }} />
    </SearchBox>
  </Frame>
);

// アイコンなしのシンプルな検索入力。
export const Plain = () => (
  <Frame maxWidth={360}>
    <SearchBox>
      <input type="search" placeholder="メンバーを検索（User ID は不要）" />
    </SearchBox>
  </Frame>
);
