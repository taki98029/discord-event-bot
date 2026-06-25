import * as React from 'react';
import { SlotGroup, TimeChip, Button } from '@eventbot/design-system';
import { Frame } from '../_frame';

// 1 日分の候補スロット。見出しに日付、続けて時刻チップ群と「時刻を追加」。
export const OneDay = () => (
  <Frame maxWidth={460}>
    <SlotGroup
      head={
        <>
          <input type="date" className="slotDate" defaultValue="2026-07-04" />
          <Button size="sm" variant="ghost">
            この日を削除
          </Button>
        </>
      }
    >
      <div className="timechips">
        <TimeChip>
          <input type="time" defaultValue="21:00" />
          <Button size="xs" variant="ghost" aria-label="削除">
            ×
          </Button>
        </TimeChip>
        <TimeChip>
          <input type="time" defaultValue="22:00" />
          <Button size="xs" variant="ghost" aria-label="削除">
            ×
          </Button>
        </TimeChip>
      </div>
      <Button size="xs" variant="secondary">
        ＋ 時刻を追加
      </Button>
    </SlotGroup>
  </Frame>
);

// 複数日を縦に重ねた日程調整の全体像。
export const MultiDay = () => (
  <Frame maxWidth={460}>
    <SlotGroup
      head={
        <>
          <input type="date" className="slotDate" defaultValue="2026-07-04" />
          <Button size="sm" variant="ghost">
            この日を削除
          </Button>
        </>
      }
    >
      <div className="timechips">
        <TimeChip>
          <input type="time" defaultValue="21:00" />
          <Button size="xs" variant="ghost" aria-label="削除">
            ×
          </Button>
        </TimeChip>
      </div>
      <Button size="xs" variant="secondary">
        ＋ 時刻を追加
      </Button>
    </SlotGroup>
    <SlotGroup
      head={
        <>
          <input type="date" className="slotDate" defaultValue="2026-07-05" />
          <Button size="sm" variant="ghost">
            この日を削除
          </Button>
        </>
      }
    >
      <div className="timechips">
        <TimeChip>
          <input type="time" defaultValue="14:00" />
          <Button size="xs" variant="ghost" aria-label="削除">
            ×
          </Button>
        </TimeChip>
        <TimeChip>
          <input type="time" defaultValue="20:00" />
          <Button size="xs" variant="ghost" aria-label="削除">
            ×
          </Button>
        </TimeChip>
      </div>
      <Button size="xs" variant="secondary">
        ＋ 時刻を追加
      </Button>
    </SlotGroup>
  </Frame>
);

// 時刻未設定（日付だけ確定）の空状態。
export const DateOnly = () => (
  <Frame maxWidth={460}>
    <SlotGroup
      head={
        <>
          <input type="date" className="slotDate" defaultValue="2026-07-12" />
          <Button size="sm" variant="ghost">
            この日を削除
          </Button>
        </>
      }
    >
      <Button size="xs" variant="secondary">
        ＋ 時刻を追加
      </Button>
    </SlotGroup>
  </Frame>
);
