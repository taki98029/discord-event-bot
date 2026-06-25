import * as React from 'react';
import { SubTabs, SubTab } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const Active = () => (
  <Frame maxWidth={240} gap={0}>
    <SubTabs>
      <SubTab active>出欠の集計</SubTab>
      <SubTab>スケジュール</SubTab>
    </SubTabs>
  </Frame>
);

export const Inactive = () => (
  <Frame maxWidth={240} gap={0}>
    <SubTabs>
      <SubTab>リマインド設定</SubTab>
      <SubTab active>メンション設定</SubTab>
    </SubTabs>
  </Frame>
);

export const SwitchingPanes = () => (
  <Frame maxWidth={240} gap={0}>
    <SubTabs>
      <SubTab active>週末イベント</SubTab>
      <SubTab>月初めの定例</SubTab>
      <SubTab>不定期の募集</SubTab>
    </SubTabs>
  </Frame>
);
