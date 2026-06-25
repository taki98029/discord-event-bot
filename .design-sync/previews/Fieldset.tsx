import * as React from 'react';
import { Fieldset, TextField, Select } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const Settings = () => (
  <Frame maxWidth={520}>
    <Fieldset legend="通知設定">
      <label htmlFor="fs-name">通知名</label>
      <TextField id="fs-name" placeholder="例: 週末イベント" defaultValue="週末イベント" />
      <label htmlFor="fs-repeat">繰り返し</label>
      <Select id="fs-repeat" defaultValue="weekly">
        <option value="weekly">毎週</option>
        <option value="biweekly">隔週</option>
        <option value="monthly">毎月</option>
      </Select>
    </Fieldset>
  </Frame>
);
