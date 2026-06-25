import * as React from 'react';
import { SummaryBanner } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const NextNotice = () => (
  <Frame maxWidth={520}>
    <SummaryBanner>✓ 次回の通知: 今週土曜 21:00（週末イベント）</SummaryBanner>
  </Frame>
);

export const ActiveCount = () => (
  <Frame maxWidth={520}>
    <SummaryBanner>✓ 3件の通知が有効・対象メンバー 24人</SummaryBanner>
  </Frame>
);
