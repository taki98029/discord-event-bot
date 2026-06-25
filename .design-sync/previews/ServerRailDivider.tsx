import * as React from 'react';
import { ServerRail, ServerRailItem, ServerRailDivider } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const BetweenGroups = () => (
  <Frame gap={0}>
    <ServerRail>
      <ServerRailItem active label="EventBot">E</ServerRailItem>
      <ServerRailDivider />
      <ServerRailItem label="ゲーム部">G</ServerRailItem>
      <ServerRailItem label="朝活コミュニティ">朝</ServerRailItem>
    </ServerRail>
  </Frame>
);
