import * as React from 'react';
import { SubTabs, SubTab } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const Basic = () => (
  <Frame maxWidth={240} gap={0}>
    <SubTabs>
      <SubTab active>通知の概要</SubTab>
      <SubTab>スケジュール</SubTab>
      <SubTab>メンション設定</SubTab>
    </SubTabs>
  </Frame>
);

export const TwoTabs = () => (
  <Frame maxWidth={240} gap={0}>
    <SubTabs>
      <SubTab active>週末イベント</SubTab>
      <SubTab>月初めの定例</SubTab>
    </SubTabs>
  </Frame>
);

export const ManyTabs = () => (
  <Frame maxWidth={240} gap={0}>
    <SubTabs>
      <SubTab>全般</SubTab>
      <SubTab active>出欠の集計</SubTab>
      <SubTab>リマインド</SubTab>
      <SubTab>表示するロール</SubTab>
      <SubTab>権限</SubTab>
    </SubTabs>
  </Frame>
);
