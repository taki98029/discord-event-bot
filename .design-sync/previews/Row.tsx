import * as React from 'react';
import { Row, Card } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const TwoCards = () => (
  <Frame>
    <Row>
      <Card>週末イベント — 毎週 土曜 21:00 に出欠を募集します。</Card>
      <Card>月初めの定例会 — 毎月 第1日曜 20:00 に開催します。</Card>
    </Row>
  </Frame>
);
