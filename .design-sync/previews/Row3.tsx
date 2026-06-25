import * as React from 'react';
import { Row3, Card } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const ThreeCards = () => (
  <Frame>
    <Row3>
      <Card>今週の出欠 — 12名が参加予定</Card>
      <Card>次回開催 — 今週土曜 21:00</Card>
      <Card>未回答 — 3名にリマインド</Card>
    </Row3>
  </Frame>
);
