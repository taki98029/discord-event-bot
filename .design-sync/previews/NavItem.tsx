import * as React from 'react';
import { SideNav, NavItem } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const Active = () => (
  <Frame maxWidth={240} gap={0}>
    <SideNav>
      <NavItem active>🔔 通知</NavItem>
    </SideNav>
  </Frame>
);

export const Inactive = () => (
  <Frame maxWidth={240} gap={0}>
    <SideNav>
      <NavItem>🗒 回答履歴</NavItem>
    </SideNav>
  </Frame>
);

export const InList = () => (
  <Frame maxWidth={240} gap={0}>
    <SideNav>
      <NavItem active>🔔 通知</NavItem>
      <NavItem>👥 メンバー区分</NavItem>
      <NavItem>⚙️ セットアップ</NavItem>
    </SideNav>
  </Frame>
);
