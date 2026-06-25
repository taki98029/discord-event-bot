import * as React from 'react';
import { Toast } from '@eventbot/design-system';
import { Frame } from '../_frame';

// .toast は position:fixed（bottom/right）でキャプチャ枠の外へ逃げて見切れるため、
// プレビューでは position:static に上書きして本来の見た目（.show＝表示状態）を枠内に収める。
const inflow: React.CSSProperties = { position: 'static' };

export const Success = () => (
  <Frame maxWidth={520}>
    <Toast open tone="ok" style={inflow}>
      通知設定を保存しました
    </Toast>
  </Frame>
);

export const Error = () => (
  <Frame maxWidth={520}>
    <Toast open tone="err" style={inflow}>
      送信に失敗しました。チャンネル権限を確認してください
    </Toast>
  </Frame>
);
