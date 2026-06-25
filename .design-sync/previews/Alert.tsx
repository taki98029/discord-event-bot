import * as React from 'react';
import { Alert } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const Tones = () => (
  <Frame maxWidth={520} gap={10}>
    <Alert tone="info" icon="ℹ️">次回の通知は今週土曜 21:00 に送信されます。</Alert>
    <Alert tone="warn" icon="⚠️">投稿先チャンネルが未設定です。セットアップから指定してください。</Alert>
    <Alert tone="danger" icon="⛔">この通知を削除すると元に戻せません。</Alert>
    <Alert tone="ok" icon="✅">3件の通知が有効になっています。</Alert>
  </Frame>
);

export const WithoutIcon = () => (
  <Frame maxWidth={520} gap={10}>
    <Alert tone="info">Bot をサーバーに招待すると、出欠リアクションの集計が始まります。</Alert>
    <Alert tone="warn">メンバー区分が未登録のため、対象者を絞り込めません。</Alert>
  </Frame>
);
