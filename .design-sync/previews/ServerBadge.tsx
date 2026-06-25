import * as React from 'react';
import { ServerBadge, Topbar } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const WithSubtitle = () => (
  <Frame maxWidth={640} gap={0}>
    <Topbar>
      <ServerBadge name="EventBot" subtitle="サーバー" fallback="E" />
    </Topbar>
  </Frame>
);

export const NameOnly = () => (
  <Frame maxWidth={640} gap={0}>
    <Topbar>
      <ServerBadge name="朝活コミュニティ" fallback="朝" />
    </Topbar>
  </Frame>
);
