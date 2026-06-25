import * as React from 'react';
import { ListRow, Button } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const WithActions = () => (
  <Frame maxWidth={520} gap={0}>
    <ListRow>
      <span>週末イベント</span>
      <div className="actions">
        <Button size="xs">編集</Button>
        <Button size="xs" variant="ghost">
          削除
        </Button>
      </div>
    </ListRow>
    <ListRow>
      <span>月初めの定例会</span>
      <div className="actions">
        <Button size="xs">編集</Button>
        <Button size="xs" variant="ghost">
          削除
        </Button>
      </div>
    </ListRow>
  </Frame>
);

export const SingleAction = () => (
  <Frame maxWidth={520} gap={0}>
    <ListRow>
      <span>通知チャンネル: #イベント告知</span>
      <Button size="xs" variant="secondary">
        変更
      </Button>
    </ListRow>
  </Frame>
);
