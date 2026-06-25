import * as React from 'react';
import { Avatar, Topbar, ServerBadge } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const Initial = () => (
  <Frame row gap={12}>
    <Avatar>E</Avatar>
    <Avatar>悩</Avatar>
    <Avatar>G</Avatar>
  </Frame>
);

export const InTopbar = () => (
  <Frame maxWidth={640} gap={0}>
    <Topbar>
      <ServerBadge name="ゲーム部" subtitle="サーバー" fallback="G" />
    </Topbar>
  </Frame>
);
