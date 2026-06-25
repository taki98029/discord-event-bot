import * as React from 'react';
import { Textarea } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const WithLabel = () => (
  <Frame maxWidth={420} gap={6}>
    <Textarea
      id="ev-desc"
      label="イベントの説明"
      rows={4}
      defaultValue={'週末イベントを開催します。\n21:00 集合、出欠は前日までに回答してください。'}
    />
  </Frame>
);

export const Placeholder = () => (
  <Frame maxWidth={420} gap={6}>
    <Textarea id="ev-note" label="通知メッセージ" rows={3} placeholder="例: 本日21時から開催します。参加者は集合してください。" />
  </Frame>
);

export const Invalid = () => (
  <Frame maxWidth={420} gap={6}>
    <Textarea
      id="ev-bad"
      label="通知メッセージ"
      rows={3}
      defaultValue=""
      invalid
      error="メッセージを入力してください"
    />
  </Frame>
);

export const Disabled = () => (
  <Frame maxWidth={420} gap={6}>
    <Textarea
      id="ev-ro"
      label="テンプレート（編集不可）"
      rows={3}
      disabled
      defaultValue={'{event_name} の出欠を受付中です。\n締切: {deadline}'}
    />
  </Frame>
);
