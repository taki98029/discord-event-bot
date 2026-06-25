import * as React from 'react';
import { TimeChip, Button } from '@eventbot/design-system';
import { Frame } from '../_frame';

// 時刻チップ単体。時刻入力＋削除ボタンを丸ピルに収める（候補時刻の最小単位）。
export const Single = () => (
  <Frame row gap={8}>
    <TimeChip>
      <input type="time" defaultValue="21:00" />
      <Button size="xs" variant="ghost" aria-label="この時刻を削除">
        ×
      </Button>
    </TimeChip>
  </Frame>
);

// 複数の候補時刻を横並びに（折り返しあり）。日程調整で 1 日に複数枠を提示する形。
export const Multiple = () => (
  <Frame row gap={8} maxWidth={360}>
    <TimeChip>
      <input type="time" defaultValue="19:30" />
      <Button size="xs" variant="ghost" aria-label="削除">
        ×
      </Button>
    </TimeChip>
    <TimeChip>
      <input type="time" defaultValue="21:00" />
      <Button size="xs" variant="ghost" aria-label="削除">
        ×
      </Button>
    </TimeChip>
    <TimeChip>
      <input type="time" defaultValue="22:30" />
      <Button size="xs" variant="ghost" aria-label="削除">
        ×
      </Button>
    </TimeChip>
  </Frame>
);
