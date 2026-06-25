import * as React from 'react';
import { EmptyState } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const NoNotices = () => (
  <Frame maxWidth={520}>
    <EmptyState>まだ通知がありません。「＋ 通知を追加」から作成してください。</EmptyState>
  </Frame>
);

export const NoHistory = () => (
  <Frame maxWidth={520}>
    <EmptyState>回答履歴はまだありません。通知を送信すると、ここに集計が表示されます。</EmptyState>
  </Frame>
);
