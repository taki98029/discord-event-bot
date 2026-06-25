import * as React from 'react';
import { Card } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const Selectable = () => (
  <Frame maxWidth={520}>
    <Card onClick={() => {}}>EventBot — 出欠と勤怠をまとめて管理するサーバー</Card>
    <Card onClick={() => {}}>お悩み相談室 — 毎週日曜の定例ミーティング</Card>
  </Frame>
);

export const Content = () => (
  <Frame maxWidth={520}>
    <Card>週末イベント — 毎週 土曜 21:00 に出欠を募集します。</Card>
  </Frame>
);
