import * as React from 'react';
import { Shell, SideNav, NavItem, Main, SummaryBanner, Card } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const AdminLayout = () => (
  <Frame>
    <Shell style={{ minHeight: 320 }}>
      <SideNav>
        <NavItem active>🔔 通知</NavItem>
        <NavItem>👥 メンバー区分</NavItem>
        <NavItem>🗒 回答履歴</NavItem>
        <NavItem>⚙️ セットアップ</NavItem>
      </SideNav>
      <Main>
        <h2>通知</h2>
        <SummaryBanner>次回: 今週土曜 21:00</SummaryBanner>
        <Card>週末イベント — 毎週 土曜</Card>
      </Main>
    </Shell>
  </Frame>
);
