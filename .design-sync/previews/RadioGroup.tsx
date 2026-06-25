import * as React from 'react';
import { Radio, RadioGroup } from '@eventbot/design-system';
import { Frame } from '../_frame';

// RadioGroup のストーリーは複数 Radio を内包し、同じ name で排他にする。
export const ThreeOptions = () => (
  <Frame maxWidth={460} gap={6}>
    <RadioGroup aria-label="DMのスパムフィルター">
      <Radio
        name="rg-dm"
        value="all"
        label="全てフィルター"
        description="全てのDMに対してスパムフィルターを行います。"
      />
      <Radio
        name="rg-dm"
        value="non-friend"
        defaultChecked
        label="フレンド以外からのDMをフィルター"
        description="フレンド以外からのDMに対してフィルターを行います。"
      />
      <Radio
        name="rg-dm"
        value="none"
        label="フィルターしない"
        description="DMに対してスパムがフィルターされません。"
      />
    </RadioGroup>
  </Frame>
);

export const TwoOptions = () => (
  <Frame maxWidth={460} gap={6}>
    <RadioGroup aria-label="通知の頻度">
      <Radio
        name="rg-freq"
        value="each"
        defaultChecked
        label="毎回通知する"
        description="イベントが作成されるたびに通知します。"
      />
      <Radio
        name="rg-freq"
        value="digest"
        label="まとめて通知する"
        description="1日1回、当日分をまとめて通知します。"
      />
    </RadioGroup>
  </Frame>
);

export const LabelOnly = () => (
  <Frame maxWidth={460} gap={6}>
    <RadioGroup aria-label="表示順">
      <Radio name="rg-sort" value="date" defaultChecked label="開催日が近い順" />
      <Radio name="rg-sort" value="name" label="名前順" />
      <Radio name="rg-sort" value="created" label="作成日順" />
    </RadioGroup>
  </Frame>
);
