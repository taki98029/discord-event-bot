import * as React from 'react';
import { GridCards, Card } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const ServerPicker = () => (
  <Frame>
    <GridCards>
      <Card onClick={() => {}}>EventBot 本番</Card>
      <Card onClick={() => {}}>お悩み相談室</Card>
      <Card onClick={() => {}}>ゲーム部</Card>
      <Card onClick={() => {}}>もくもく会</Card>
    </GridCards>
  </Frame>
);
