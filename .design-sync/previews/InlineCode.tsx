import * as React from 'react';
import { InlineCode } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const InProse = () => (
  <Frame maxWidth={520} gap={10}>
    <p style={{ margin: 0, lineHeight: 1.7 }}>
      ビルドは <InlineCode>npm run build</InlineCode> で生成し、デプロイは{' '}
      <InlineCode>npm run deploy</InlineCode> を実行します。
    </p>
    <p style={{ margin: 0, lineHeight: 1.7 }}>
      投稿先は環境変数 <InlineCode>DISCORD_CHANNEL_ID</InlineCode> で指定してください。
    </p>
  </Frame>
);

export const Tokens = () => (
  <Frame row gap={8}>
    <InlineCode>毎週 土曜</InlineCode>
    <InlineCode>21:00 JST</InlineCode>
    <InlineCode>#お知らせ</InlineCode>
  </Frame>
);
