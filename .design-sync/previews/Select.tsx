import * as React from 'react';
import { Select } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const WithLabel = () => (
  <Frame maxWidth={380} gap={6}>
    <Select id="ev-repeat" label="繰り返し" defaultValue="weekly">
      <option value="weekly">毎週</option>
      <option value="biweekly">隔週</option>
      <option value="monthly">毎月</option>
    </Select>
  </Frame>
);

export const ManyOptions = () => (
  <Frame maxWidth={380} gap={6}>
    <Select id="ev-weekday" label="開催曜日" defaultValue="sat">
      <option value="mon">月曜</option>
      <option value="tue">火曜</option>
      <option value="wed">水曜</option>
      <option value="thu">木曜</option>
      <option value="fri">金曜</option>
      <option value="sat">土曜</option>
      <option value="sun">日曜</option>
    </Select>
  </Frame>
);

export const Invalid = () => (
  <Frame maxWidth={380} gap={6}>
    <Select id="ev-ch" label="投稿先チャンネル" defaultValue="" invalid error="チャンネルを選択してください">
      <option value="" disabled>
        選択してください…
      </option>
      <option value="general">＃一般</option>
      <option value="event">＃イベント</option>
    </Select>
  </Frame>
);

export const Disabled = () => (
  <Frame maxWidth={380} gap={6}>
    <Select id="ev-tz" label="タイムゾーン（変更不可）" defaultValue="jst" disabled>
      <option value="jst">日本標準時 (JST)</option>
    </Select>
  </Frame>
);
