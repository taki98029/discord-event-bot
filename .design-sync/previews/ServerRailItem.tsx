import * as React from 'react';
import { ServerRail, ServerRailItem } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const Active = () => (
  <Frame gap={0}>
    <ServerRail>
      <ServerRailItem active label="EventBot">E</ServerRailItem>
    </ServerRail>
  </Frame>
);

export const Inactive = () => (
  <Frame gap={0}>
    <ServerRail>
      <ServerRailItem label="お悩み相談室">悩</ServerRailItem>
    </ServerRail>
  </Frame>
);

export const AddButton = () => (
  <Frame gap={0}>
    <ServerRail>
      <ServerRailItem className="add" label="サーバーを追加">＋</ServerRailItem>
    </ServerRail>
  </Frame>
);
