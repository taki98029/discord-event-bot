import * as React from 'react';
import { Table, Pill } from '@eventbot/design-system';
import { Frame } from '../_frame';

export const NotificationList = () => (
  <Frame maxWidth={560}>
    <Table>
      <thead>
        <tr>
          <th>通知名</th>
          <th>繰り返し</th>
          <th>状態</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>週末イベント</td>
          <td>毎週 土曜</td>
          <td>
            <Pill tone="on">有効</Pill>
          </td>
        </tr>
        <tr>
          <td>月初めの定例会</td>
          <td>毎月 第1日曜</td>
          <td>
            <Pill tone="off">無効</Pill>
          </td>
        </tr>
        <tr>
          <td>朝活もくもく会</td>
          <td>平日 毎朝</td>
          <td>
            <Pill tone="on">有効</Pill>
          </td>
        </tr>
      </tbody>
    </Table>
  </Frame>
);
