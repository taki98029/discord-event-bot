import * as React from 'react';
import { PickRow, Pill, Button } from '@eventbot/design-system';
import { Frame } from '../_frame';

// 候補メンバーの 1 行。左にラベル、右に「追加」ボタン（両端寄せ）。
export const Addable = () => (
  <Frame maxWidth={420}>
    <PickRow>
      <span>さくら</span>
      <Button size="xs">追加</Button>
    </PickRow>
    <PickRow>
      <span>たくみ</span>
      <Button size="xs">追加</Button>
    </PickRow>
    <PickRow>
      <span>みなと</span>
      <Button size="xs">追加</Button>
    </PickRow>
  </Frame>
);

// 選択済み（区分バッジ付き）と削除ボタン。
export const Selected = () => (
  <Frame maxWidth={420}>
    <PickRow>
      <span>
        さくら <Pill tone="on">参加</Pill>
      </span>
      <Button size="xs" variant="ghost">
        外す
      </Button>
    </PickRow>
    <PickRow>
      <span>
        たくみ <Pill tone="off">未定</Pill>
      </span>
      <Button size="xs" variant="ghost">
        外す
      </Button>
    </PickRow>
  </Frame>
);
