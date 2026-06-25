import * as React from 'react';
import { DropdownButton } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const Basic = () => (
  <Frame maxWidth={240} gap={10}>
    <DropdownButton icon="👁">表示</DropdownButton>
  </Frame>
);

export const Blocked = () => (
  <Frame maxWidth={240} gap={10}>
    <DropdownButton icon="🚫">ブロック</DropdownButton>
  </Frame>
);

export const Open = () => (
  <Frame maxWidth={240} gap={10}>
    <DropdownButton icon="🔁" open>
      毎週
    </DropdownButton>
  </Frame>
);

export const Choices = () => (
  <Frame maxWidth={240} gap={10}>
    <DropdownButton icon="🔔">全員にメンション</DropdownButton>
    <DropdownButton icon="🔕">メンションなし</DropdownButton>
  </Frame>
);
