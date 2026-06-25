import * as React from 'react';
import { NavRow } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const Basic = () => (
  <Frame maxWidth={520} gap={0}>
    <NavRow
      icon="✅"
      title="Bot の接続状態"
      description="EventBot は正常にこのサーバーへ接続されています"
    />
  </Frame>
);

export const WithoutDescription = () => (
  <Frame maxWidth={520} gap={0}>
    <NavRow icon="⚙️" title="セットアップをやり直す" />
    <NavRow icon="📦" title="メンバー区分を編集" />
  </Frame>
);

export const NoChevron = () => (
  <Frame maxWidth={520} gap={0}>
    <NavRow
      icon="🔔"
      title="通知チャンネル"
      description="#イベント告知"
      chevron={false}
    />
  </Frame>
);

export const SettingsList = () => (
  <Frame maxWidth={520} gap={0}>
    <NavRow icon="🔔" title="通知" description="定例イベントの告知と出欠確認" />
    <NavRow icon="👥" title="メンバー区分" description="ロールごとの出欠集計" />
    <NavRow icon="🗒" title="回答履歴" description="過去のイベントの出欠を確認" />
  </Frame>
);
