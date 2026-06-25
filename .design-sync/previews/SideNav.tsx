import * as React from 'react';
import { SideNav, NavItem } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const AdminMenu = () => (
  <Frame maxWidth={240} gap={0}>
    <SideNav>
      <NavItem active>🔔 通知</NavItem>
      <NavItem>👥 メンバー区分</NavItem>
      <NavItem>🗒 回答履歴</NavItem>
      <NavItem>⚙️ セットアップ</NavItem>
    </SideNav>
  </Frame>
);

export const MembersSelected = () => (
  <Frame maxWidth={240} gap={0}>
    <SideNav>
      <NavItem>🔔 通知</NavItem>
      <NavItem active>👥 メンバー区分</NavItem>
      <NavItem>🗒 回答履歴</NavItem>
      <NavItem>⚙️ セットアップ</NavItem>
    </SideNav>
  </Frame>
);
