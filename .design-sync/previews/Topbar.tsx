import * as React from 'react';
import { Topbar, ServerBadge, Button } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const Default = () => (
  <Frame maxWidth={640} gap={0}>
    <Topbar>
      <ServerBadge name="EventBot" subtitle="サーバー" fallback="E" />
      <div className="actions">
        <Button variant="secondary">ログアウト</Button>
      </div>
    </Topbar>
  </Frame>
);

export const WithActions = () => (
  <Frame maxWidth={640} gap={0}>
    <Topbar>
      <ServerBadge name="お悩み相談室" subtitle="通知を編集中" fallback="悩" />
      <div className="actions">
        <Button size="sm" variant="ghost">プレビュー</Button>
        <Button size="sm">保存</Button>
      </div>
    </Topbar>
  </Frame>
);
