import * as React from 'react';
import { Pill } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const Tones = () => (
  <Frame row gap={8}>
    <Pill tone="neutral">下書き</Pill>
    <Pill tone="on">有効</Pill>
    <Pill tone="off">無効</Pill>
  </Frame>
);

export const InContext = () => (
  <Frame row gap={8}>
    <Pill tone="on">毎週 土曜</Pill>
    <Pill tone="off">一時停止中</Pill>
    <Pill tone="neutral">未送信</Pill>
  </Frame>
);
