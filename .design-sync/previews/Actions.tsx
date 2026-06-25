import * as React from 'react';
import { Actions, Button } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const FormFooter = () => (
  <Frame maxWidth={520}>
    <Actions>
      <Button variant="ghost">キャンセル</Button>
      <Button variant="secondary">下書き保存</Button>
      <Button>通知を作成</Button>
    </Actions>
  </Frame>
);

export const Destructive = () => (
  <Frame maxWidth={520}>
    <Actions>
      <Button variant="ghost">戻る</Button>
      <Button variant="danger">この通知を削除</Button>
    </Actions>
  </Frame>
);
