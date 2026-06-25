import * as React from 'react';
import { Modal, Button } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const Confirm = () => (
  <Frame maxWidth={560}>
    <Modal
      open
      title="通知を削除"
      onClose={() => {}}
      footer={
        <>
          <Button variant="ghost">キャンセル</Button>
          <Button variant="danger">削除</Button>
        </>
      }
    >
      <p>「週末イベント」を削除しますか？この操作は取り消せません。</p>
    </Modal>
  </Frame>
);
