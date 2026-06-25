import * as React from 'react';
import { Radio, RadioGroup } from '@eventbot/design-system';
import { Frame } from '../_frame';

// Radio は単体では文脈が成立しないため、必ず RadioGroup で囲み同じ name を渡す。
export const Selected = () => (
  <Frame maxWidth={420} gap={6}>
    <RadioGroup>
      <Radio
        name="r-remind"
        value="all"
        defaultChecked
        label="全員に通知"
        description="出席・欠席・未回答すべてのメンバーへ送ります。"
      />
      <Radio
        name="r-remind"
        value="pending"
        label="未回答者のみ"
        description="まだ回答していないメンバーにだけ送ります。"
      />
    </RadioGroup>
  </Frame>
);

export const WithDescription = () => (
  <Frame maxWidth={420} gap={6}>
    <RadioGroup>
      <Radio
        name="r-dm"
        value="all"
        label="全てフィルター"
        description="全てのDMに対してスパムフィルターを行います。"
      />
      <Radio
        name="r-dm"
        value="non-friend"
        defaultChecked
        label="フレンド以外からのDMをフィルター"
        description="フレンド以外からのDMに対してフィルターを行います。"
      />
      <Radio
        name="r-dm"
        value="none"
        label="フィルターしない"
        description="DMに対してスパムがフィルターされません。"
      />
    </RadioGroup>
  </Frame>
);

export const Disabled = () => (
  <Frame maxWidth={420} gap={6}>
    <RadioGroup>
      <Radio
        name="r-plan"
        value="free"
        defaultChecked
        disabled
        label="無料プラン（現在のプラン）"
        description="アップグレードするまで変更できません。"
      />
      <Radio name="r-plan" value="pro" disabled label="Pro プラン" description="近日公開予定。" />
    </RadioGroup>
  </Frame>
);
