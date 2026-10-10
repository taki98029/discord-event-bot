/** 先頭 n 字（UTF-16）で切る。絵文字などのサロゲートペアの途中なら 1 つ手前で切る（管理画面と共用） */
export function cutText(s: string, n: number): string {
  const code = s.charCodeAt(n - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}
