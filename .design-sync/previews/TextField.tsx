import * as React from 'react';
import { TextField } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const WithLabel = () => (
  <Frame maxWidth={380} gap={6}>
    <TextField id="ev-name" label="イベント名" placeholder="例: 週末イベント" defaultValue="週末イベント" />
  </Frame>
);

export const Placeholder = () => (
  <Frame maxWidth={380} gap={6}>
    <TextField id="ev-empty" label="チャンネルID" placeholder="例: 123456789012345678" />
  </Frame>
);

export const Invalid = () => (
  <Frame maxWidth={380} gap={6}>
    <TextField id="ev-bad" label="開始時刻" defaultValue="25:00" invalid error="時刻の形式が正しくありません（HH:MM）" />
  </Frame>
);

export const Disabled = () => (
  <Frame maxWidth={380} gap={6}>
    <TextField id="ev-ro" label="サーバー名（変更不可）" defaultValue="EventBot" disabled />
  </Frame>
);
