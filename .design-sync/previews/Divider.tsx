import * as React from 'react';
import { Divider } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const Between = () => (
  <Frame maxWidth={520}>
    <div className="setting-row-title">通知設定</div>
    <Divider />
    <div className="setting-row-title">メンバー区分</div>
    <Divider />
    <div className="setting-row-title">セットアップ</div>
  </Frame>
);
