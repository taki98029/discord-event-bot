import * as React from 'react';
import { Button } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const Variants = () => (
  <Frame row>
    <Button>保存</Button>
    <Button variant="secondary">プレビュー</Button>
    <Button variant="danger">削除</Button>
    <Button variant="ghost">キャンセル</Button>
  </Frame>
);

export const Sizes = () => (
  <Frame row>
    <Button size="md">標準</Button>
    <Button size="sm">小</Button>
    <Button size="xs">極小</Button>
  </Frame>
);

export const States = () => (
  <Frame row>
    <Button busy>保存中…</Button>
    <Button disabled>無効</Button>
    <Button variant="danger" size="xs">
      ×
    </Button>
  </Frame>
);
