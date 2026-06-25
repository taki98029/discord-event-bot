import * as React from 'react';
import { Switch } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const On = () => (
  <Frame row gap={12}>
    <Switch defaultChecked aria-label="通知を有効にする" />
    <span>通知を有効にする</span>
  </Frame>
);

export const Off = () => (
  <Frame row gap={12}>
    <Switch aria-label="ミュート" />
    <span>このサーバーをミュート</span>
  </Frame>
);

export const Disabled = () => (
  <Frame gap={12}>
    <Frame row gap={12}>
      <Switch defaultChecked disabled aria-label="管理者により固定（ON）" />
      <span>DM のスパムフィルター（管理者が固定）</span>
    </Frame>
    <Frame row gap={12}>
      <Switch disabled aria-label="管理者により固定（OFF）" />
      <span>外部連携（プラン上限のため無効）</span>
    </Frame>
  </Frame>
);
