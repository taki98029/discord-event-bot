import * as React from 'react';
import { SettingRow, Switch, Select, DropdownButton } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const WithSwitch = () => (
  <Frame maxWidth={520} gap={0}>
    <SettingRow
      title="フレンドがオンライン"
      description="オンラインになったら通知します"
      control={<Switch defaultChecked />}
    />
    <SettingRow title="フレンドがプロフィールを更新" control={<Switch />} />
  </Frame>
);

export const WithSelect = () => (
  <Frame maxWidth={520} gap={0}>
    <SettingRow
      title="リアクション通知"
      control={
        <Select defaultValue="all" style={{ width: 'auto' }}>
          <option value="all">すべてのメッセージ</option>
          <option value="none">なし</option>
        </Select>
      }
    />
  </Frame>
);

export const WithDropdown = () => (
  <Frame maxWidth={520} gap={0}>
    <SettingRow
      title="フレンドからのダイレクトメッセージ"
      control={<DropdownButton icon="👁">表示</DropdownButton>}
    />
    <SettingRow
      title="その他の人からのダイレクトメッセージ"
      control={<DropdownButton icon="🚫">ブロック</DropdownButton>}
    />
  </Frame>
);
