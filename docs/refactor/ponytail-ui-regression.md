# Ponytail リファクタ UI マニュアル回帰チェックリスト

Phase 4 (ui/index.html 重複統合) と Phase 5 (design-system/styles 整理) で実施する 7 項目チェックリスト。

## 起動

```bash
# ローカル UI 起動
node design-system/serve.mjs   # Phase 3 統合後はこのコマンドに収束
# または
node scripts/serve-setup.mjs   # setup.html プレビュー
```

ブラウザで `http://localhost:5578/index.html` を開く (port は serve スクリプトの既定)。
ADMIN_TOKEN は staging のものを使用、または `[[ui-verify-stub-api]]` メモリ通りの window.api スタブ。

## チェックリスト（7 項目）

| # | 項目 | Phase 4 確認点 | Phase 5 確認点 |
|---|---|---|---|
| 1 | ログインフロー | ADMIN_TOKEN 入力→認証成功→ギルド選択 | UI 崩れなし |
| 2 | 通知一覧描画 | テーブル / 空ステート / pagination | テーブル罫線・余白崩れなし |
| 3 | 通知作成→保存→破棄ダイアログ | **confirmDialog 統合の動作確認**: 「編集中の内容を破棄しますか？」が表示・OK/キャンセル動く | フォーム入力欄スタイル崩れなし |
| 4 | 通知削除→確認モーダル | **confirmDialog 統合の動作確認**: 削除確認モーダル表示・OK で削除実行 | モーダル枠・ボタン色崩れなし |
| 5 | 日付表示 | **fmtDate/fmtTimeRange 統合後の出力 100% 一致**: 一覧の「次回開催日」「締切時刻」が以前と同じ文字列 | — |
| 6 | キーボード操作 | モーダル開く→Esc で閉じる、Tab フォーカス移動、Enter で OK | a11y 退行なし |
| 7 | CSS 表示 | — | **`preview_screenshot` で Before/After 保存**: ヘッダ・サイドバー・ボタン色・テーブル罫線が崩れていない |

## 失敗時の対応

- Phase 4 のいずれかが失敗 → 該当コミットを `git revert`、原因究明後に再着手
- Phase 5 の (7) で CSS 退行 → 削除した未参照クラスが実は参照されていた → grep 漏れ。即 revert + 該当クラス復活
