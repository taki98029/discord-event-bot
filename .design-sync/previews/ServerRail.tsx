import * as React from 'react';
import { ServerRail, ServerRailItem, ServerRailDivider } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const Default = () => (
  <Frame gap={0}>
    <ServerRail>
      <ServerRailItem active label="EventBot">E</ServerRailItem>
      <ServerRailDivider />
      <ServerRailItem label="お悩み相談室">悩</ServerRailItem>
      <ServerRailItem label="ゲーム部">G</ServerRailItem>
      <ServerRailItem label="朝活コミュニティ">朝</ServerRailItem>
      <ServerRailItem className="add" label="サーバーを追加">＋</ServerRailItem>
    </ServerRail>
  </Frame>
);

export const SingleServer = () => (
  <Frame gap={0}>
    <ServerRail>
      <ServerRailItem active label="EventBot">E</ServerRailItem>
      <ServerRailDivider />
      <ServerRailItem className="add" label="サーバーを追加">＋</ServerRailItem>
    </ServerRail>
  </Frame>
);
