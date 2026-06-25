import * as React from 'react';
import { Main, SummaryBanner, Card } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const NotificationsView = () => (
  <Frame>
    <Main>
      <h2>通知</h2>
      <SummaryBanner>次回: 今週土曜 21:00 に出欠を募集します</SummaryBanner>
      <Card>週末イベント — 毎週 土曜</Card>
      <Card>月初めの定例会 — 毎月 第1日曜</Card>
    </Main>
  </Frame>
);
