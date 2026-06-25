import * as React from 'react';
import { Checkbox } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const Checked = () => (
  <Frame gap={6}>
    <Checkbox defaultChecked label="通知を有効にする" />
  </Frame>
);

export const Unchecked = () => (
  <Frame gap={6}>
    <Checkbox label="開始10分前にリマインドする" />
  </Frame>
);

export const Group = () => (
  <Frame gap={4}>
    <Checkbox defaultChecked label="出席者にDMを送る" />
    <Checkbox defaultChecked label="欠席者にもDMを送る" />
    <Checkbox label="未回答者にのみ再通知する" />
  </Frame>
);

export const Disabled = () => (
  <Frame gap={6}>
    <Checkbox defaultChecked disabled label="管理者ロール（必須・変更不可）" />
  </Frame>
);
